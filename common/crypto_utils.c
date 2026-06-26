#include "crypto_utils.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const char HEX[] = "0123456789abcdef";

static int hex_value(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

static int hex_to_bytes(const char *hex, unsigned char *out, size_t out_len) {
    size_t hex_len;

    if (hex == NULL || out == NULL) {
        return -1;
    }
    hex_len = strlen(hex);
    if (hex_len != out_len * 2) {
        return -1;
    }

    for (size_t i = 0; i < out_len; ++i) {
        int hi = hex_value(hex[i * 2]);
        int lo = hex_value(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) {
            return -1;
        }
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 0;
}

static void bytes_to_hex(const unsigned char *bytes, size_t len, char *out) {
    for (size_t i = 0; i < len; ++i) {
        out[i * 2] = HEX[(bytes[i] >> 4) & 0x0f];
        out[i * 2 + 1] = HEX[bytes[i] & 0x0f];
    }
    out[len * 2] = '\0';
}

int generate_salt_hex(char *out, size_t out_size) {
    unsigned char salt[SALT_BYTES];

    if (out == NULL || out_size < SALT_HEX_LEN + 1) {
        return -1;
    }
    if (RAND_bytes(salt, sizeof(salt)) != 1) {
        return -1;
    }
    bytes_to_hex(salt, sizeof(salt), out);
    return 0;
}

int hash_password(const char *password, const char *salt_hex, char *out,
                  size_t out_size) {
    unsigned char salt[SALT_BYTES];
    unsigned char digest[PASSWORD_HASH_BYTES];
    unsigned int digest_len = 0;
    EVP_MD_CTX *ctx;

    if (password == NULL || salt_hex == NULL || out == NULL ||
        out_size < PASSWORD_HASH_HEX_LEN + 1) {
        return -1;
    }
    if (hex_to_bytes(salt_hex, salt, sizeof(salt)) < 0) {
        return -1;
    }

    ctx = EVP_MD_CTX_new();
    if (ctx == NULL) {
        return -1;
    }
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), NULL) != 1 ||
        EVP_DigestUpdate(ctx, salt, sizeof(salt)) != 1 ||
        EVP_DigestUpdate(ctx, (const unsigned char *)password,
                         strlen(password)) != 1 ||
        EVP_DigestFinal_ex(ctx, digest, &digest_len) != 1 ||
        digest_len != PASSWORD_HASH_BYTES) {
        EVP_MD_CTX_free(ctx);
        return -1;
    }
    EVP_MD_CTX_free(ctx);
    bytes_to_hex(digest, sizeof(digest), out);
    return 0;
}

bool verify_password(const char *password, const char *salt_hex,
                     const char *expected_hash) {
    char actual[PASSWORD_HASH_HEX_LEN + 1];

    if (expected_hash == NULL ||
        strlen(expected_hash) != PASSWORD_HASH_HEX_LEN) {
        return false;
    }
    if (hash_password(password, salt_hex, actual, sizeof(actual)) < 0) {
        return false;
    }
    return strcmp(actual, expected_hash) == 0;
}
