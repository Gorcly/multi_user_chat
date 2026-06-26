#ifndef CRYPTO_UTILS_H
#define CRYPTO_UTILS_H

#include <stddef.h>
#include <stdbool.h>

#define SALT_BYTES 16
#define SALT_HEX_LEN (SALT_BYTES * 2)
#define PASSWORD_HASH_BYTES 32
#define PASSWORD_HASH_HEX_LEN (PASSWORD_HASH_BYTES * 2)

int generate_salt_hex(char *out, size_t out_size);
int hash_password(const char *password, const char *salt_hex, char *out,
                  size_t out_size);
bool verify_password(const char *password, const char *salt_hex,
                     const char *expected_hash);

#endif
