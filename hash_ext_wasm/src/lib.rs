#![no_std]
// FNV-1a hash functions for DuckDB WASM extension.
// no_std avoids duplicating std symbols when multiple Rust staticlibs are linked.

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

const FNV_INIT: u64 = 14695981039346656037;
const FNV_PRIME: u64 = 1099511628211;
const NULL_PLACEHOLDER: &[u8] = b"$$null_placeholder$$";

fn fnv1a_feed(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

fn hash_two(a: &[u8], b: &[u8]) -> u64 {
    let h = fnv1a_feed(FNV_INIT, a);
    let h = h ^ 0xFF;
    let h = h.wrapping_mul(FNV_PRIME);
    fnv1a_feed(h, b)
}

// ---------------------------------------------------------------------------
// Exported: FNV-1a(a || 0xFF || b). Used by row_hash(id, value).
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn fnv1a_hash_two(
    a: *const u8, a_len: usize,
    b: *const u8, b_len: usize,
) -> u64 {
    let a_bytes = unsafe { core::slice::from_raw_parts(a, a_len) };
    let b_bytes = unsafe { core::slice::from_raw_parts(b, b_len) };
    hash_two(a_bytes, b_bytes)
}

// ---------------------------------------------------------------------------
// Minimal JSON property extractor — no_std, zero-copy, zero-allocation.
//
// DuckDB's JSON type is stored as raw UTF-8 bytes (a VARCHAR internally).
// The pointer DuckDB passes is a direct view into its string buffer —
// no serialisation, no copies. Rust reads the same memory.
// ---------------------------------------------------------------------------

fn skip_ws(json: &[u8], mut i: usize) -> usize {
    while i < json.len() && matches!(json[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn skip_value(json: &[u8], mut i: usize) -> Option<usize> {
    if i >= json.len() { return None; }
    match json[i] {
        b'"' => {
            i += 1;
            loop {
                if i >= json.len() { return None; }
                match json[i] {
                    b'\\' => i += 2,
                    b'"'  => return Some(i + 1),
                    _     => i += 1,
                }
            }
        }
        b'{' | b'[' => {
            let mut depth = 1i32;
            i += 1;
            while i < json.len() {
                match json[i] {
                    b'"' => {
                        i += 1;
                        while i < json.len() {
                            match json[i] {
                                b'\\' => i += 2,
                                b'"'  => { i += 1; break; }
                                _     => i += 1,
                            }
                        }
                    }
                    b'{' | b'[' => { depth += 1; i += 1; }
                    b'}' | b']' => { depth -= 1; i += 1; if depth == 0 { return Some(i); } }
                    _ => i += 1,
                }
            }
            None
        }
        _ => {
            while i < json.len()
                && !matches!(json[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
            {
                i += 1;
            }
            Some(i)
        }
    }
}

/// Find the raw bytes of `key`'s value in a flat JSON object.
/// String values: content between outer quotes.
/// Scalar values (number/bool/null): raw bytes.
/// Returns None if key not found.
fn json_find_value<'a>(json: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut i = 0;
    while i < json.len() && json[i] != b'{' { i += 1; }
    if i >= json.len() { return None; }
    i += 1;

    loop {
        i = skip_ws(json, i);
        if i >= json.len() { return None; }
        if json[i] == b'}' { return None; }
        if json[i] == b',' { i += 1; continue; }

        if json[i] != b'"' { return None; }
        i += 1;
        let key_start = i;
        while i < json.len() && json[i] != b'"' {
            if json[i] == b'\\' { i += 1; }
            i += 1;
        }
        if i >= json.len() { return None; }
        let key_end = i;
        i += 1;

        i = skip_ws(json, i);
        if i >= json.len() || json[i] != b':' { return None; }
        i += 1;
        i = skip_ws(json, i);
        if i >= json.len() { return None; }

        if &json[key_start..key_end] == key {
            return if json[i] == b'"' {
                i += 1;
                let start = i;
                loop {
                    if i >= json.len() { return None; }
                    match json[i] {
                        b'\\' => i += 2,
                        b'"'  => return Some(&json[start..i]),
                        _     => i += 1,
                    }
                }
            } else {
                let start = i;
                while i < json.len()
                    && !matches!(json[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
                {
                    i += 1;
                }
                Some(&json[start..i])
            };
        } else {
            i = skip_value(json, i)?;
        }
    }
}

// ---------------------------------------------------------------------------
// Exported: extract raw value bytes for a key from a JSON object.
// String values: bytes between the quotes (no quotes in output).
// Scalar values (number/bool/null): raw bytes.
// Returns true and sets *out_ptr/*out_len on success (pointer into json buffer).
// Returns false if key not found.
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn json_extract_raw(
    json: *const u8, json_len: usize,
    key:  *const u8, key_len:  usize,
    out_ptr: *mut *const u8,
    out_len: *mut usize,
) -> bool {
    let json_bytes = unsafe { core::slice::from_raw_parts(json, json_len) };
    let key_bytes  = unsafe { core::slice::from_raw_parts(key,  key_len)  };
    match json_find_value(json_bytes, key_bytes) {
        Some(value) => {
            unsafe {
                *out_ptr = value.as_ptr();
                *out_len = value.len();
            }
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Exported: hash a single JSON field. Used by hash_json(json, key).
// Computes FNV-1a(key || 0xFF || extracted_value).
// Returns true + *out_hash on success; false (NULL result) if key not found.
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn fnv1a_hash_json_field(
    json: *const u8, json_len: usize,
    key:  *const u8, key_len:  usize,
    out_hash: *mut u64,
) -> bool {
    let json_bytes = unsafe { core::slice::from_raw_parts(json, json_len) };
    let key_bytes  = unsafe { core::slice::from_raw_parts(key,  key_len)  };

    match json_find_value(json_bytes, key_bytes) {
        Some(value) => {
            unsafe { *out_hash = hash_two(key_bytes, value); }
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Exported: feed one JSON field into a running FNV-1a hash state.
// Used by hash_json_keys / hash_json_keys_table for multi-key hashing.
//
// C++ initialises h = FNV_INIT (14695981039346656037ULL), then calls this
// once per key. Each call hashes: key_bytes + 0xFF sep + value_bytes + 0xFE sep.
// The two different separators prevent collisions between (k1+v1) and (k1v1).
//
// Missing keys and JSON null values are treated identically: both use
// NULL_PLACEHOLDER as the value bytes. This ensures that {'a': null} and {}
// produce the same hash for key 'a'. Always returns true.
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn fnv1a_hash_json_field_feed(
    h:    *mut u64,
    json: *const u8, json_len: usize,
    key:  *const u8, key_len:  usize,
) -> bool {
    let json_bytes = unsafe { core::slice::from_raw_parts(json, json_len) };
    let key_bytes  = unsafe { core::slice::from_raw_parts(key,  key_len)  };

    let value = match json_find_value(json_bytes, key_bytes) {
        Some(v) if v == b"null" => NULL_PLACEHOLDER,
        Some(v) => v,
        None => NULL_PLACEHOLDER,
    };

    let mut hh = unsafe { *h };
    // hash key bytes
    hh = fnv1a_feed(hh, key_bytes);
    // separator between key and value
    hh ^= 0xFF;
    hh = hh.wrapping_mul(FNV_PRIME);
    // hash value bytes
    hh = fnv1a_feed(hh, value);
    // separator between key-value pairs
    hh ^= 0xFE;
    hh = hh.wrapping_mul(FNV_PRIME);
    unsafe { *h = hh; }
    true
}
