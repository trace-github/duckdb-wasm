#pragma once
#include <cstddef>
#include <cstdint>

extern "C" {

uint64_t fnv1a_hash_two(
    const uint8_t *a, size_t a_len,
    const uint8_t *b, size_t b_len
);

bool fnv1a_hash_json_field(
    const uint8_t *json, size_t json_len,
    const uint8_t *key,  size_t key_len,
    uint64_t *out_hash
);

bool fnv1a_hash_json_field_feed(
    uint64_t        *h,
    const uint8_t   *json, size_t json_len,
    const uint8_t   *key,  size_t key_len
);

bool json_extract_raw(
    const uint8_t  *json, size_t json_len,
    const uint8_t  *key,  size_t key_len,
    const uint8_t **out_ptr,
    size_t         *out_len
);

} // extern "C"