// hash_ext DuckDB WASM extension
// Registers:
//   row_hash(id VARCHAR, value VARCHAR) -> VARCHAR
//   hash_row(row STRUCT, col_name VARCHAR) -> VARCHAR
//   hash_table((SELECT ...)) -> TABLE(id, value, hash, types)
//   hash_json(json VARCHAR, key VARCHAR) -> VARCHAR

#include "duckdb/web/extensions/hash_ext_extension.h"

#include "duckdb.hpp"
#include "duckdb/planner/expression/bound_function_expression.hpp"
#include "duckdb/planner/expression/bound_constant_expression.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <string>
#include <vector>
#include <utility>

extern "C" uint64_t fnv1a_hash_two(
    const uint8_t *a, size_t a_len,
    const uint8_t *b, size_t b_len
);

// Extracts `key` from the JSON object bytes and computes FNV-1a(key, value).
// Returns true and writes the hash to *out_hash on success.
// Returns false (key not found) → caller sets result to NULL.
// json is DuckDB's raw string buffer — Rust reads the same memory, zero-copy.
extern "C" bool fnv1a_hash_json_field(
    const uint8_t *json, size_t json_len,
    const uint8_t *key,  size_t key_len,
    uint64_t *out_hash
);

// Feeds one JSON field into a running FNV-1a hash state (for multi-key hashing).
// C++ initialises h = FNV_INIT, calls this once per key in the name_list.
// Missing keys and JSON null values use a placeholder — always returns true.
extern "C" bool fnv1a_hash_json_field_feed(
    uint64_t        *h,
    const uint8_t   *json, size_t json_len,
    const uint8_t   *key,  size_t key_len
);

// Extracts raw value bytes for a key from a JSON object.
// String values: content between quotes (no quotes in output).
// Scalar values: raw bytes. Returns false if key not found.
extern "C" bool json_extract_raw(
    const uint8_t  *json, size_t json_len,
    const uint8_t  *key,  size_t key_len,
    const uint8_t **out_ptr,
    size_t         *out_len
);

// FNV-1a initial value — matches Rust's FNV_INIT constant.
static constexpr uint64_t FNV_INIT_VALUE = 14695981039346656037ULL;

namespace duckdb {

// ---------------------------------------------------------------------------
// Scalar: row_hash(id VARCHAR, value VARCHAR) -> VARCHAR
// ---------------------------------------------------------------------------

static void RowHashScalarFunction(DataChunk &args, ExpressionState &state, Vector &result) {
    auto count = args.size();

    UnifiedVectorFormat id_fmt, val_fmt;
    args.data[0].ToUnifiedFormat(count, id_fmt);
    args.data[1].ToUnifiedFormat(count, val_fmt);

    auto id_data  = id_fmt.GetData<string_t>();
    auto val_data = val_fmt.GetData<string_t>();

    result.SetVectorType(VectorType::FLAT_VECTOR);
    auto out = FlatVector::GetData<string_t>(result);

    char buf[17];
    for (idx_t i = 0; i < count; i++) {
        const auto &id  = id_data[id_fmt.sel->get_index(i)];
        const auto &val = val_data[val_fmt.sel->get_index(i)];

        uint64_t hash = fnv1a_hash_two(
            reinterpret_cast<const uint8_t *>(id.GetData()),  id.GetSize(),
            reinterpret_cast<const uint8_t *>(val.GetData()), val.GetSize()
        );
        snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(hash));
        out[i] = StringVector::AddString(result, buf, 16);
    }
}

// ---------------------------------------------------------------------------
// Scalar: hash_row(row STRUCT, col_name VARCHAR) -> VARCHAR
//
// Extracts the named VARCHAR field from the struct and computes:
//   fnv1a_hash_two(col_name_bytes, field_value_bytes)
//
// Performance: when col_name is a constant the field index is resolved at
// bind time; ToUnifiedFormat on the target child vector is called once per
// DataChunk, giving the same O(count) cost as row_hash.
// ---------------------------------------------------------------------------

struct HashRowBindData : public FunctionData {
    idx_t field_idx  = DConstants::INVALID_INDEX; // pre-resolved if col_name constant
    string field_name;

    unique_ptr<FunctionData> Copy() const override {
        auto c = make_uniq<HashRowBindData>();
        c->field_idx  = field_idx;
        c->field_name = field_name;
        return c;
    }
    bool Equals(const FunctionData &other) const override {
        auto &o = other.Cast<HashRowBindData>();
        return field_idx == o.field_idx && field_name == o.field_name;
    }
};

static unique_ptr<FunctionData> HashRowBind(
    ClientContext &context,
    ScalarFunction &bound_function,
    vector<unique_ptr<Expression>> &arguments)
{
    auto &struct_type = arguments[0]->return_type;
    if (struct_type.id() != LogicalTypeId::STRUCT) {
        throw BinderException("hash_row: first argument must be a STRUCT (got %s)",
            struct_type.ToString());
    }

    auto bd = make_uniq<HashRowBindData>();

    if (arguments[1]->expression_class == ExpressionClass::BOUND_CONSTANT) {
        auto col_name = arguments[1]->Cast<BoundConstantExpression>().value.GetValue<string>();
        bd->field_name = col_name;

        idx_t n = StructType::GetChildCount(struct_type);
        for (idx_t i = 0; i < n; i++) {
            if (StructType::GetChildName(struct_type, i) == col_name) {
                bd->field_idx = i;
                break;
            }
        }
        if (bd->field_idx == DConstants::INVALID_INDEX) {
            throw BinderException("hash_row: field '%s' not found in %s",
                col_name, struct_type.ToString());
        }
        auto &child_type = StructType::GetChildType(struct_type, bd->field_idx);
        if (child_type.id() != LogicalTypeId::VARCHAR) {
            throw BinderException("hash_row: field '%s' is %s; only VARCHAR supported",
                col_name, child_type.ToString());
        }
    }

    return bd;
}

static void HashRowScalarFunction(DataChunk &args, ExpressionState &state, Vector &result) {
    auto count = args.size();

    // Retrieve pre-resolved field index from bind data (INVALID if col_name is variable).
    auto &func_expr = state.expr.Cast<BoundFunctionExpression>();
    idx_t const_field = func_expr.bind_info
        ? func_expr.bind_info->Cast<HashRowBindData>().field_idx
        : DConstants::INVALID_INDEX;

    auto &struct_vec  = args.data[0];
    auto &struct_type = struct_vec.GetType();
    auto &entries     = StructVector::GetEntries(struct_vec);
    idx_t child_count = StructType::GetChildCount(struct_type);

    UnifiedVectorFormat struct_vdata;
    struct_vec.ToUnifiedFormat(count, struct_vdata);

    UnifiedVectorFormat col_fmt;
    args.data[1].ToUnifiedFormat(count, col_fmt);
    auto col_data = col_fmt.GetData<string_t>();

    result.SetVectorType(VectorType::FLAT_VECTOR);
    auto out = FlatVector::GetData<string_t>(result);
    char buf[17];

    if (const_field != DConstants::INVALID_INDEX) {
        // Fast path: field index known at bind time; one ToUnifiedFormat per chunk.
        UnifiedVectorFormat child_vdata;
        entries[const_field]->ToUnifiedFormat(count, child_vdata);
        auto child_str = child_vdata.GetData<string_t>();
        const auto &col_name = col_data[col_fmt.sel->get_index(0)]; // constant

        for (idx_t i = 0; i < count; i++) {
            if (!struct_vdata.validity.RowIsValid(struct_vdata.sel->get_index(i))) {
                FlatVector::SetNull(result, i, true); continue;
            }
            auto ci = child_vdata.sel->get_index(i);
            if (!child_vdata.validity.RowIsValid(ci)) {
                FlatVector::SetNull(result, i, true); continue;
            }
            const auto &val = child_str[ci];
            uint64_t hash = fnv1a_hash_two(
                reinterpret_cast<const uint8_t *>(col_name.GetData()), col_name.GetSize(),
                reinterpret_cast<const uint8_t *>(val.GetData()),      val.GetSize()
            );
            snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(hash));
            out[i] = StringVector::AddString(result, buf, 16);
        }
    } else {
        // Slow path: variable col_name; pre-format all VARCHAR children.
        vector<UnifiedVectorFormat> child_fmts(child_count);
        for (idx_t j = 0; j < child_count; j++) {
            if (entries[j]->GetType().id() == LogicalTypeId::VARCHAR) {
                entries[j]->ToUnifiedFormat(count, child_fmts[j]);
            }
        }

        for (idx_t i = 0; i < count; i++) {
            if (!struct_vdata.validity.RowIsValid(struct_vdata.sel->get_index(i))) {
                FlatVector::SetNull(result, i, true); continue;
            }
            const auto &col_name = col_data[col_fmt.sel->get_index(i)];

            idx_t field_idx = DConstants::INVALID_INDEX;
            for (idx_t j = 0; j < child_count; j++) {
                const auto &name = StructType::GetChildName(struct_type, j);
                if (name.size() == col_name.GetSize() &&
                    memcmp(name.data(), col_name.GetData(), col_name.GetSize()) == 0) {
                    field_idx = j; break;
                }
            }
            if (field_idx == DConstants::INVALID_INDEX ||
                entries[field_idx]->GetType().id() != LogicalTypeId::VARCHAR) {
                FlatVector::SetNull(result, i, true); continue;
            }
            auto &cfmt = child_fmts[field_idx];
            auto ci = cfmt.sel->get_index(i);
            if (!cfmt.validity.RowIsValid(ci)) {
                FlatVector::SetNull(result, i, true); continue;
            }
            const auto &val = cfmt.GetData<string_t>()[ci];
            uint64_t hash = fnv1a_hash_two(
                reinterpret_cast<const uint8_t *>(col_name.GetData()), col_name.GetSize(),
                reinterpret_cast<const uint8_t *>(val.GetData()),      val.GetSize()
            );
            snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(hash));
            out[i] = StringVector::AddString(result, buf, 16);
        }
    }
}

// ---------------------------------------------------------------------------
// Table function: hash_table(TABLE ...) -> TABLE(id, value, hash, types)
//
// Streaming in-out function — accepts a TABLE parameter and computes
// fnv1a_hash_two(id, value) for each input row without buffering.
// The 'types' column is VARCHAR[] listing the data type of every input column.
//
// Usage:
//   SELECT * FROM hash_table((SELECT id, value FROM src))
//   SELECT * FROM hash_table((SELECT id, value FROM src WHERE id = 'x'))
// ---------------------------------------------------------------------------

struct HashTableBindData : public FunctionData {
    idx_t id_col  = 0;
    idx_t val_col = 1;
    std::string id_name;
    std::string val_name;
    std::vector<std::string> col_types; // type name of every input column

    HashTableBindData(idx_t ic, idx_t vc, std::string in, std::string vn,
                      std::vector<std::string> ct)
        : id_col(ic), val_col(vc), id_name(std::move(in)), val_name(std::move(vn)),
          col_types(std::move(ct)) {}

    unique_ptr<FunctionData> Copy() const override {
        return make_uniq<HashTableBindData>(id_col, val_col, id_name, val_name, col_types);
    }
    bool Equals(const FunctionData &other) const override {
        auto &o = other.Cast<HashTableBindData>();
        return id_col == o.id_col && val_col == o.val_col && col_types == o.col_types;
    }
};

static unique_ptr<FunctionData> HashTableBind(
    ClientContext &context,
    TableFunctionBindInput &input,
    vector<LogicalType> &return_types,
    vector<string> &names)
{
    if (input.input_table_types.size() < 2) {
        throw BinderException("hash_table: input table must have at least 2 columns (id, value)");
    }
    if (input.input_table_types[0].id() != LogicalTypeId::VARCHAR ||
        input.input_table_types[1].id() != LogicalTypeId::VARCHAR) {
        throw BinderException("hash_table: first two columns must be VARCHAR");
    }

    std::string id_name  = input.input_table_names.size() > 0 ? input.input_table_names[0] : "id";
    std::string val_name = input.input_table_names.size() > 1 ? input.input_table_names[1] : "value";

    std::vector<std::string> col_types;
    col_types.reserve(input.input_table_types.size());
    for (auto &t : input.input_table_types) {
        col_types.push_back(t.ToString());
    }

    return_types = {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR,
                    LogicalType::LIST(LogicalType::VARCHAR)};
    names = {id_name, val_name, "hash", "types"};

    return make_uniq<HashTableBindData>(0, 1, id_name, val_name, std::move(col_types));
}

static OperatorResultType HashTableInOutFunc(
    ExecutionContext &context,
    TableFunctionInput &data,
    DataChunk &input,
    DataChunk &output)
{
    auto &bind = data.bind_data->Cast<HashTableBindData>();
    idx_t n = input.size();
    output.SetCardinality(n);

    UnifiedVectorFormat id_fmt, val_fmt;
    input.data[bind.id_col].ToUnifiedFormat(n, id_fmt);
    input.data[bind.val_col].ToUnifiedFormat(n, val_fmt);

    auto id_data  = id_fmt.GetData<string_t>();
    auto val_data = val_fmt.GetData<string_t>();

    auto id_out   = FlatVector::GetData<string_t>(output.data[0]);
    auto val_out  = FlatVector::GetData<string_t>(output.data[1]);
    auto hash_out = FlatVector::GetData<string_t>(output.data[2]);
    char buf[17];

    for (idx_t i = 0; i < n; i++) {
        const auto &id_s  = id_data[id_fmt.sel->get_index(i)];
        const auto &val_s = val_data[val_fmt.sel->get_index(i)];

        uint64_t h = fnv1a_hash_two(
            reinterpret_cast<const uint8_t *>(id_s.GetData()),  id_s.GetSize(),
            reinterpret_cast<const uint8_t *>(val_s.GetData()), val_s.GetSize()
        );
        snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));

        id_out[i]   = StringVector::AddString(output.data[0], id_s);
        val_out[i]  = StringVector::AddString(output.data[1], val_s);
        hash_out[i] = StringVector::AddString(output.data[2], buf, 16);
    }

    // Build types LIST column — same list for every row, determined at bind time.
    auto &types_vec = output.data[3];
    idx_t k = bind.col_types.size();
    ListVector::Reserve(types_vec, n * k);
    ListVector::SetListSize(types_vec, n * k);

    auto &child_vec  = ListVector::GetEntry(types_vec);
    auto  child_data = FlatVector::GetData<string_t>(child_vec);
    auto  list_ent   = FlatVector::GetData<list_entry_t>(types_vec);

    for (idx_t i = 0; i < n; i++) {
        list_ent[i] = {i * k, k};
        for (idx_t j = 0; j < k; j++) {
            child_data[i * k + j] = StringVector::AddString(child_vec, bind.col_types[j]);
        }
    }

    return OperatorResultType::NEED_MORE_INPUT;
}

// ---------------------------------------------------------------------------
// Scalar: hash_json(json VARCHAR, key VARCHAR) -> VARCHAR
//
// Extracts the value of `key` from the JSON string and computes
// FNV-1a(key, extracted_value) — identical semantics to row_hash(key, value).
//
// DuckDB's JSON type is stored as raw UTF-8 bytes (it IS a VARCHAR internally).
// The pointer passed to Rust IS DuckDB's string buffer: zero-copy, no parse,
// no alloc. Rust's json_find_value walks the bytes directly.
//
// Returns NULL when the key is not present in the JSON object.
// ---------------------------------------------------------------------------

static void HashJsonScalarFunction(DataChunk &args, ExpressionState &state, Vector &result) {
    auto count = args.size();

    UnifiedVectorFormat json_fmt, key_fmt;
    args.data[0].ToUnifiedFormat(count, json_fmt);
    args.data[1].ToUnifiedFormat(count, key_fmt);

    auto json_data = json_fmt.GetData<string_t>();
    auto key_data  = key_fmt.GetData<string_t>();

    result.SetVectorType(VectorType::FLAT_VECTOR);
    auto  out      = FlatVector::GetData<uint32_t>(result);
    auto &validity = FlatVector::Validity(result);

    for (idx_t i = 0; i < count; i++) {
        const auto &json = json_data[json_fmt.sel->get_index(i)];
        const auto &key  = key_data[key_fmt.sel->get_index(i)];

        uint64_t h = 0;
        bool found = fnv1a_hash_json_field(
            reinterpret_cast<const uint8_t *>(json.GetData()), json.GetSize(),
            reinterpret_cast<const uint8_t *>(key.GetData()),  key.GetSize(),
            &h
        );

        if (!found) {
            validity.SetInvalid(i);
        } else {
            out[i] = static_cast<uint32_t>(h);
        }
    }
}

// ---------------------------------------------------------------------------
// Scalar: hash_json_keys(name_list VARCHAR[], value_json VARCHAR) -> VARCHAR
//
// Equivalent to the DuckDB macro:
//   hash(name_list || json_extract_string(value_json, name_list))
//
// For each key in name_list, extracts its value from the JSON and feeds both
// key and value into a running FNV-1a hash. C++ calls Rust once per key via
// fnv1a_hash_json_field_feed, which reads DuckDB's raw string buffer directly.
// Missing keys and JSON null values are treated identically (hashed with a
// placeholder). Empty key list returns 1. Always returns a non-null hash.
// ---------------------------------------------------------------------------

static void HashJsonKeysScalarFunction(DataChunk &args, ExpressionState &state, Vector &result) {
    auto count = args.size();

    // args.data[0]: LIST(VARCHAR) — key names
    // args.data[1]: VARCHAR       — JSON string
    auto &list_vec = args.data[0];
    auto &json_vec = args.data[1];

    UnifiedVectorFormat list_fmt;
    list_vec.ToUnifiedFormat(count, list_fmt);
    auto list_entries = list_fmt.GetData<list_entry_t>();

    auto &child_vec  = ListVector::GetEntry(list_vec);
    idx_t child_size = ListVector::GetListSize(list_vec);
    UnifiedVectorFormat child_fmt;
    child_vec.ToUnifiedFormat(child_size, child_fmt);
    auto child_data = child_fmt.GetData<string_t>();

    UnifiedVectorFormat json_fmt;
    json_vec.ToUnifiedFormat(count, json_fmt);
    auto json_data = json_fmt.GetData<string_t>();

    result.SetVectorType(VectorType::FLAT_VECTOR);
    auto  out      = FlatVector::GetData<uint32_t>(result);
    auto &validity = FlatVector::Validity(result);

    for (idx_t i = 0; i < count; i++) {
        auto li = list_fmt.sel->get_index(i);
        auto ji = json_fmt.sel->get_index(i);

        const auto &json   = json_data[ji];
        const auto &lentry = list_entries[li];

        // Empty key list → return 1
        if (lentry.length == 0) {
            out[i] = 1;
            continue;
        }

        uint64_t h = FNV_INIT_VALUE;

        for (idx_t j = 0; j < lentry.length; j++) {
            auto ci = child_fmt.sel->get_index(lentry.offset + j);
            const auto &key = child_data[ci];
            fnv1a_hash_json_field_feed(
                &h,
                reinterpret_cast<const uint8_t *>(json.GetData()), json.GetSize(),
                reinterpret_cast<const uint8_t *>(key.GetData()),  key.GetSize()
            );
        }

        out[i] = static_cast<uint32_t>(h);
    }
}

// ---------------------------------------------------------------------------
// Table function: hash_json_keys_table(TABLE, name_list VARCHAR[]) -> (hash VARCHAR)
//
// Streaming in-out: key list captured once at bind time; inner loop calls
// fnv1a_hash_json_field_feed once per key per row with no allocation.
// ---------------------------------------------------------------------------

struct HashJsonKeysTableBindData : public FunctionData {
    std::vector<std::string> key_names;

    unique_ptr<FunctionData> Copy() const override {
        auto c = make_uniq<HashJsonKeysTableBindData>();
        c->key_names = key_names;
        return c;
    }
    bool Equals(const FunctionData &other) const override {
        return key_names == other.Cast<HashJsonKeysTableBindData>().key_names;
    }
};

static unique_ptr<FunctionData> HashJsonKeysTableBind(
    ClientContext &context,
    TableFunctionBindInput &input,
    vector<LogicalType> &return_types,
    vector<string> &names)
{
    if (input.input_table_types.empty()) {
        throw BinderException("hash_json_keys_table: input table must have at least one column");
    }

    // input.inputs[0] is an empty placeholder for the TABLE parameter;
    // the scalar LIST argument is at input.inputs[1].
    if (input.inputs.size() < 2) {
        throw BinderException("hash_json_keys_table: second argument must be a VARCHAR[] key list");
    }
    auto &key_arg = input.inputs[1];
    if (key_arg.IsNull() || key_arg.type().id() != LogicalTypeId::LIST) {
        throw BinderException("hash_json_keys_table: second argument must be a non-null VARCHAR[] constant list");
    }

    auto bd = make_uniq<HashJsonKeysTableBindData>();
    auto &key_vals = ListValue::GetChildren(key_arg);
    for (auto &kv : key_vals) {
        if (!kv.IsNull()) {
            bd->key_names.push_back(kv.GetValue<string>());
        }
    }

    return_types = {LogicalType::UINTEGER};
    names = {"hash"};
    return bd;
}

static OperatorResultType HashJsonKeysTableInOutFunc(
    ExecutionContext &context,
    TableFunctionInput &data,
    DataChunk &input,
    DataChunk &output)
{
    auto &bind = data.bind_data->Cast<HashJsonKeysTableBindData>();
    idx_t n = input.size();
    output.SetCardinality(n);

    // First column of the input TABLE is the JSON column
    UnifiedVectorFormat json_fmt;
    input.data[0].ToUnifiedFormat(n, json_fmt);
    auto json_data = json_fmt.GetData<string_t>();

    auto  out      = FlatVector::GetData<uint32_t>(output.data[0]);
    auto &validity = FlatVector::Validity(output.data[0]);

    bool empty_keys = bind.key_names.empty();

    for (idx_t i = 0; i < n; i++) {
        if (empty_keys) {
            out[i] = 1;
            continue;
        }

        const auto &json = json_data[json_fmt.sel->get_index(i)];
        uint64_t h = FNV_INIT_VALUE;

        for (const auto &key_name : bind.key_names) {
            fnv1a_hash_json_field_feed(
                &h,
                reinterpret_cast<const uint8_t *>(json.GetData()), json.GetSize(),
                reinterpret_cast<const uint8_t *>(key_name.data()), key_name.size()
            );
        }

        out[i] = static_cast<uint32_t>(h);
    }
    return OperatorResultType::NEED_MORE_INPUT;
}

// ---------------------------------------------------------------------------
// Table function: metric_table(TABLE, series_id_key, parent_keys, target_key, duck_json_type)
//
// Streaming in-out that enriches a metrics stream.  Input table must have:
//   vals  JSON     — the JSON payload
//   value FLOAT    — metric value (passed through)
//   count INTEGER  — sample count (passed through)
//
// Output columns:
//   vals              JSON     — pass-through
//   series_id         VARCHAR  — json_extract_string(vals, series_id_key)
//   parent_match_hash UINTEGER — FNV-1a over parent_keys values
//   target_match_hash UINTEGER — FNV-1a over parent_keys + target_key values
//   value_varchar     VARCHAR  — typed extraction when duck_json_type = 'varchar'
//   value_bigint      BIGINT   — typed extraction when duck_json_type = 'bigint'
//   value_double      DOUBLE   — typed extraction when duck_json_type = 'double'
//   value_boolean     BOOLEAN  — typed extraction when duck_json_type = 'boolean'
//   value             <input>  — pass-through
//   count             <input>  — pass-through
// ---------------------------------------------------------------------------

struct MetricTableBindData : public FunctionData {
    idx_t vals_col_idx  = DConstants::INVALID_INDEX;
    idx_t value_col_idx = DConstants::INVALID_INDEX;
    idx_t count_col_idx = DConstants::INVALID_INDEX;
    LogicalType value_type;
    LogicalType count_type;
    std::string series_id_key;
    std::vector<std::string> parent_keys;
    std::string target_key;

    unique_ptr<FunctionData> Copy() const override {
        auto c = make_uniq<MetricTableBindData>();
        c->vals_col_idx   = vals_col_idx;
        c->value_col_idx  = value_col_idx;
        c->count_col_idx  = count_col_idx;
        c->value_type     = value_type;
        c->count_type     = count_type;
        c->series_id_key  = series_id_key;
        c->parent_keys    = parent_keys;
        c->target_key     = target_key;
        return c;
    }
    bool Equals(const FunctionData &other) const override {
        auto &o = other.Cast<MetricTableBindData>();
        return vals_col_idx == o.vals_col_idx && value_col_idx == o.value_col_idx &&
               count_col_idx == o.count_col_idx && series_id_key == o.series_id_key &&
               parent_keys == o.parent_keys && target_key == o.target_key;
    }
};

static unique_ptr<FunctionData> MetricTableBind(
    ClientContext &context,
    TableFunctionBindInput &input,
    vector<LogicalType> &return_types,
    vector<string> &names)
{
    if (input.input_table_types.empty())
        throw BinderException("metric_table: input table must have columns");
    // inputs[0]=TABLE placeholder, [1]=series_id_key, [2]=parent_keys, [3]=target_key
    if (input.inputs.size() < 4)
        throw BinderException("metric_table: requires 3 scalar arguments (series_id_key, parent_keys, target_key)");

    auto bd = make_uniq<MetricTableBindData>();

    for (idx_t i = 0; i < input.input_table_names.size(); i++) {
        const auto &nm = input.input_table_names[i];
        if (nm == "vals")  bd->vals_col_idx  = i;
        if (nm == "value") bd->value_col_idx = i;
        if (nm == "count") bd->count_col_idx = i;
    }
    if (bd->vals_col_idx  == DConstants::INVALID_INDEX)
        throw BinderException("metric_table: input table must have a 'vals' JSON column");
    if (bd->value_col_idx == DConstants::INVALID_INDEX)
        throw BinderException("metric_table: input table must have a 'value' column");
    if (bd->count_col_idx == DConstants::INVALID_INDEX)
        throw BinderException("metric_table: input table must have a 'count' column");

    bd->value_type = input.input_table_types[bd->value_col_idx];
    bd->count_type = input.input_table_types[bd->count_col_idx];

    bd->series_id_key = input.inputs[1].IsNull() ? "" : input.inputs[1].GetValue<string>();
    if (!input.inputs[2].IsNull() && input.inputs[2].type().id() == LogicalTypeId::LIST) {
        for (auto &kv : ListValue::GetChildren(input.inputs[2])) {
            if (!kv.IsNull()) bd->parent_keys.push_back(kv.GetValue<string>());
        }
    }
    bd->target_key = input.inputs[3].IsNull() ? "" : input.inputs[3].GetValue<string>();

    return_types = {
        LogicalType::VARCHAR,  // 0  vals
        LogicalType::VARCHAR,  // 1  series_id
        LogicalType::UINTEGER, // 2  parent_match_hash
        LogicalType::UINTEGER, // 3  target_match_hash
        LogicalType::UINTEGER, // 4  target_value_hash
        bd->value_type,        // 5  value  (pass-through)
        bd->count_type,        // 6  count  (pass-through)
    };
    names = {"vals", "series_id", "parent_match_hash", "target_match_hash",
             "target_value_hash", "value", "count"};
    return bd;
}

static OperatorResultType MetricTableInOutFunc(
    ExecutionContext &context,
    TableFunctionInput &data,
    DataChunk &input,
    DataChunk &output)
{
    auto &bind = data.bind_data->Cast<MetricTableBindData>();
    idx_t n = input.size();
    output.SetCardinality(n);

    // Pass-through columns — zero-copy reference into input vectors
    output.data[0].Reference(input.data[bind.vals_col_idx]);
    output.data[5].Reference(input.data[bind.value_col_idx]);
    output.data[6].Reference(input.data[bind.count_col_idx]);

    // Read vals for field extraction
    UnifiedVectorFormat vals_fmt;
    input.data[bind.vals_col_idx].ToUnifiedFormat(n, vals_fmt);
    auto vals_data = vals_fmt.GetData<string_t>();

    // Output pointers for computed columns
    auto  sid_out = FlatVector::GetData<string_t>(output.data[1]);
    auto  pmh_out = FlatVector::GetData<uint32_t>(output.data[2]);
    auto  tmh_out = FlatVector::GetData<uint32_t>(output.data[3]);
    auto  tvh_out = FlatVector::GetData<uint32_t>(output.data[4]);

    auto &sid_v = FlatVector::Validity(output.data[1]);
    auto &pmh_v = FlatVector::Validity(output.data[2]);
    auto &tmh_v = FlatVector::Validity(output.data[3]);
    auto &tvh_v = FlatVector::Validity(output.data[4]);

    const bool has_target = !bind.target_key.empty();

    for (idx_t i = 0; i < n; i++) {
        auto vi = vals_fmt.sel->get_index(i);

        if (!vals_fmt.validity.RowIsValid(vi)) {
            sid_v.SetInvalid(i); pmh_v.SetInvalid(i);
            tmh_v.SetInvalid(i); tvh_v.SetInvalid(i);
            continue;
        }

        const auto &json = vals_data[vi];
        const uint8_t *jp = reinterpret_cast<const uint8_t *>(json.GetData());
        size_t jl = json.GetSize();

        // ---- series_id ----
        {
            const uint8_t *p; size_t l;
            if (json_extract_raw(jp, jl,
                    reinterpret_cast<const uint8_t *>(bind.series_id_key.data()),
                    bind.series_id_key.size(), &p, &l) &&
                !(l == 4 && memcmp(p, "null", 4) == 0)) {
                sid_out[i] = StringVector::AddString(output.data[1],
                                 reinterpret_cast<const char *>(p), l);
            } else {
                sid_v.SetInvalid(i);
            }
        }

        // ---- parent_match_hash ----
        if (!bind.parent_keys.empty()) {
            uint64_t h = FNV_INIT_VALUE; bool ok = true;
            for (const auto &k : bind.parent_keys) {
                if (!fnv1a_hash_json_field_feed(&h, jp, jl,
                        reinterpret_cast<const uint8_t *>(k.data()), k.size())) {
                    ok = false; break;
                }
            }
            if (ok) pmh_out[i] = static_cast<uint32_t>(h);
            else pmh_v.SetInvalid(i);
        } else {
            pmh_v.SetInvalid(i);
        }

        // ---- target_match_hash (parent_keys + target_key) ----
        if (has_target) {
            uint64_t h = FNV_INIT_VALUE; bool ok = true;
            for (const auto &k : bind.parent_keys) {
                if (!fnv1a_hash_json_field_feed(&h, jp, jl,
                        reinterpret_cast<const uint8_t *>(k.data()), k.size())) {
                    ok = false; break;
                }
            }
            if (ok && !fnv1a_hash_json_field_feed(&h, jp, jl,
                    reinterpret_cast<const uint8_t *>(bind.target_key.data()),
                    bind.target_key.size())) {
                ok = false;
            }
            if (ok) tmh_out[i] = static_cast<uint32_t>(h);
            else tmh_v.SetInvalid(i);
        } else {
            tmh_v.SetInvalid(i);
        }

        // ---- target_value_hash: hash_json(vals, target_key) ----
        if (has_target) {
            uint64_t h = 0;
            if (fnv1a_hash_json_field(jp, jl,
                    reinterpret_cast<const uint8_t *>(bind.target_key.data()),
                    bind.target_key.size(), &h)) {
                tvh_out[i] = static_cast<uint32_t>(h);
            } else {
                tvh_v.SetInvalid(i);
            }
        } else {
            tvh_v.SetInvalid(i);
        }

    }
    return OperatorResultType::NEED_MORE_INPUT;
}

// ---------------------------------------------------------------------------
// Scalar: json_typed_extract(json VARCHAR, key VARCHAR, type VARCHAR)
//         -> STRUCT(value_varchar VARCHAR, value_bigint BIGINT,
//                   value_double DOUBLE, value_boolean BOOLEAN)
//
// Extracts the value of `key` from a JSON object and populates the struct
// field matching `type` ('varchar'|'bigint'|'double'|'boolean'). The other
// three fields are always NULL. Returns all-NULL struct when key is absent
// or value is JSON null.
//
// Usage:
//   SELECT (json_typed_extract(vals, 'dbl_val', 'double')).value_double
//   SELECT (json_typed_extract(vals, 'flag',    'boolean')).*
// ---------------------------------------------------------------------------

static LogicalType JsonTypedExtractType() {
    child_list_t<LogicalType> members;
    members.push_back({"value_varchar", LogicalType::VARCHAR});
    members.push_back({"value_bigint",  LogicalType::BIGINT});
    members.push_back({"value_double",  LogicalType::DOUBLE});
    members.push_back({"value_boolean", LogicalType::BOOLEAN});
    return LogicalType::STRUCT(std::move(members));
}

static void JsonTypedExtractFunction(DataChunk &args, ExpressionState &state, Vector &result) {
    idx_t count = args.size();

    UnifiedVectorFormat json_fmt, key_fmt, type_fmt;
    args.data[0].ToUnifiedFormat(count, json_fmt);
    args.data[1].ToUnifiedFormat(count, key_fmt);
    args.data[2].ToUnifiedFormat(count, type_fmt);

    auto json_data = json_fmt.GetData<string_t>();
    auto key_data  = key_fmt.GetData<string_t>();
    auto type_data = type_fmt.GetData<string_t>();

    auto &entries = StructVector::GetEntries(result);
    auto  vvc_out = FlatVector::GetData<string_t>(*entries[0]);
    auto  vbi_out = FlatVector::GetData<int64_t> (*entries[1]);
    auto  vdb_out = FlatVector::GetData<double>  (*entries[2]);
    auto  vbo_out = FlatVector::GetData<bool>    (*entries[3]);

    auto &vvc_v = FlatVector::Validity(*entries[0]);
    auto &vbi_v = FlatVector::Validity(*entries[1]);
    auto &vdb_v = FlatVector::Validity(*entries[2]);
    auto &vbo_v = FlatVector::Validity(*entries[3]);

    for (idx_t i = 0; i < count; i++) {
        const auto &json = json_data[json_fmt.sel->get_index(i)];
        const auto &key  = key_data [key_fmt.sel->get_index(i)];
        const auto &type = type_data[type_fmt.sel->get_index(i)];

        const bool is_varchar = (type.GetSize() == 7 && memcmp(type.GetData(), "varchar", 7) == 0);
        const bool is_bigint  = (type.GetSize() == 6 && memcmp(type.GetData(), "bigint",  6) == 0);
        const bool is_double  = (type.GetSize() == 6 && memcmp(type.GetData(), "double",  6) == 0);
        const bool is_boolean = (type.GetSize() == 7 && memcmp(type.GetData(), "boolean", 7) == 0);

        // non-matching columns are always NULL
        if (!is_varchar) vvc_v.SetInvalid(i);
        if (!is_bigint)  vbi_v.SetInvalid(i);
        if (!is_double)  vdb_v.SetInvalid(i);
        if (!is_boolean) vbo_v.SetInvalid(i);

        if (!(is_varchar || is_bigint || is_double || is_boolean) || key.GetSize() == 0)
            continue;

        const uint8_t *jp = reinterpret_cast<const uint8_t *>(json.GetData());
        size_t jl = json.GetSize();
        const uint8_t *p; size_t l;
        bool found = json_extract_raw(jp, jl,
            reinterpret_cast<const uint8_t *>(key.GetData()), key.GetSize(), &p, &l);
        if (!found || (l == 4 && memcmp(p, "null", 4) == 0)) {
            // already nulled above; explicitly null the matching type col
            if (is_varchar)      vvc_v.SetInvalid(i);
            else if (is_bigint)  vbi_v.SetInvalid(i);
            else if (is_double)  vdb_v.SetInvalid(i);
            else if (is_boolean) vbo_v.SetInvalid(i);
            continue;
        }

        if (is_varchar) {
            vvc_out[i] = StringVector::AddString(*entries[0],
                             reinterpret_cast<const char *>(p), l);
        } else if (is_bigint) {
            char buf[32];
            size_t bl = l < sizeof(buf) - 1 ? l : sizeof(buf) - 1;
            memcpy(buf, p, bl); buf[bl] = '\0';
            char *end; errno = 0;
            int64_t v = strtoll(buf, &end, 10);
            if (end == buf || errno == ERANGE) vbi_v.SetInvalid(i);
            else vbi_out[i] = v;
        } else if (is_double) {
            char buf[64];
            size_t bl = l < sizeof(buf) - 1 ? l : sizeof(buf) - 1;
            memcpy(buf, p, bl); buf[bl] = '\0';
            char *end;
            double v = strtod(buf, &end);
            if (end == buf) vdb_v.SetInvalid(i);
            else vdb_out[i] = v;
        } else { // is_boolean
            if      (l == 4 && memcmp(p, "true",  4) == 0) vbo_out[i] = true;
            else if (l == 5 && memcmp(p, "false", 5) == 0) vbo_out[i] = false;
            else vbo_v.SetInvalid(i);
        }
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

class HashExtExtension : public Extension {
public:
    void Load(ExtensionLoader &loader) override {
        loader.RegisterFunction(ScalarFunction(
            "row_hash",
            {LogicalType::VARCHAR, LogicalType::VARCHAR},
            LogicalType::VARCHAR,
            RowHashScalarFunction
        ));
        loader.RegisterFunction(ScalarFunction(
            "hash_row",
            {LogicalType::ANY, LogicalType::VARCHAR},
            LogicalType::VARCHAR,
            HashRowScalarFunction,
            HashRowBind
        ));
        TableFunction hash_table_fn("hash_table", {LogicalType::TABLE}, nullptr, HashTableBind);
        hash_table_fn.in_out_function = HashTableInOutFunc;
        loader.RegisterFunction(hash_table_fn);
        loader.RegisterFunction(ScalarFunction(
            "hash_json",
            {LogicalType::VARCHAR, LogicalType::VARCHAR},
            LogicalType::UINTEGER,
            HashJsonScalarFunction
        ));
        loader.RegisterFunction(ScalarFunction(
            "hash_json_keys",
            {LogicalType::LIST(LogicalType::VARCHAR), LogicalType::VARCHAR},
            LogicalType::UINTEGER,
            HashJsonKeysScalarFunction
        ));
        TableFunction hash_json_keys_table_fn(
            "hash_json_keys_table",
            {LogicalType::TABLE, LogicalType::LIST(LogicalType::VARCHAR)},
            nullptr,
            HashJsonKeysTableBind
        );
        hash_json_keys_table_fn.in_out_function = HashJsonKeysTableInOutFunc;
        loader.RegisterFunction(hash_json_keys_table_fn);
        TableFunction metric_table_fn(
            "metric_table",
            {LogicalType::TABLE,
             LogicalType::VARCHAR,
             LogicalType::LIST(LogicalType::VARCHAR),
             LogicalType::VARCHAR},
            nullptr,
            MetricTableBind
        );
        metric_table_fn.in_out_function = MetricTableInOutFunc;
        loader.RegisterFunction(metric_table_fn);
        loader.RegisterFunction(ScalarFunction(
            "json_typed_extract",
            {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR},
            JsonTypedExtractType(),
            JsonTypedExtractFunction
        ));
    }
    std::string Name() override { return "hash_ext"; }
};

} // namespace duckdb

extern "C" void duckdb_web_hash_ext_init(duckdb::DuckDB *db) {
    db->LoadStaticExtension<duckdb::HashExtExtension>();
}
