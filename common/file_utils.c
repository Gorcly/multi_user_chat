#include "file_utils.h"

#include "protocol.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

int ensure_directory(const char *path) {
    struct stat st;

    if (path == NULL || path[0] == '\0') {
        return -1;
    }
    if (stat(path, &st) == 0) {
        return S_ISDIR(st.st_mode) ? 0 : -1;
    }
    if (mkdir(path, 0755) == 0) {
        return 0;
    }
    return errno == EEXIST ? 0 : -1;
}

const char *base_filename(const char *path) {
    const char *slash;

    if (path == NULL) {
        return "";
    }
    slash = strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

static void sanitize_component(const char *in, char *out, size_t out_size) {
    size_t j = 0;

    if (out_size == 0) {
        return;
    }
    for (size_t i = 0; in != NULL && in[i] != '\0' && j + 1 < out_size; ++i) {
        char c = in[i];
        if (c == '/' || c == '\\' || c == ':' || c == '\n' || c == '\r') {
            out[j++] = '_';
        } else {
            out[j++] = c;
        }
    }
    out[j] = '\0';
}

int build_unique_download_path(const char *dir, const char *sender,
                               const char *filename, char *out,
                               size_t out_size) {
    char safe_sender[128];
    char safe_file[FILE_NAME_MAX_LEN];
    char stem[FILE_NAME_MAX_LEN];
    char ext[FILE_NAME_MAX_LEN];
    const char *dot;

    if (dir == NULL || sender == NULL || filename == NULL || out == NULL ||
        out_size == 0) {
        return -1;
    }
    if (ensure_directory(dir) < 0) {
        return -1;
    }

    sanitize_component(sender, safe_sender, sizeof(safe_sender));
    sanitize_component(base_filename(filename), safe_file, sizeof(safe_file));
    if (safe_sender[0] == '\0' || safe_file[0] == '\0') {
        return -1;
    }

    dot = strrchr(safe_file, '.');
    if (dot != NULL && dot != safe_file) {
        size_t stem_len = (size_t)(dot - safe_file);
        if (stem_len >= sizeof(stem)) {
            stem_len = sizeof(stem) - 1;
        }
        memcpy(stem, safe_file, stem_len);
        stem[stem_len] = '\0';
        snprintf(ext, sizeof(ext), "%s", dot);
    } else {
        snprintf(stem, sizeof(stem), "%s", safe_file);
        ext[0] = '\0';
    }

    for (int i = 0; i < 1000; ++i) {
        int needed;
        char *candidate;

        if (i == 0) {
            needed = snprintf(NULL, 0, "%s/%s_%s%s", dir, safe_sender, stem,
                              ext);
        } else {
            needed = snprintf(NULL, 0, "%s/%s_%s_%d%s", dir, safe_sender,
                              stem, i, ext);
        }
        if (needed < 0 || (size_t)needed + 1 > out_size) {
            return -1;
        }
        candidate = (char *)malloc((size_t)needed + 1);
        if (candidate == NULL) {
            return -1;
        }
        if (i == 0) {
            snprintf(candidate, (size_t)needed + 1, "%s/%s_%s%s", dir,
                     safe_sender, stem, ext);
        } else {
            snprintf(candidate, (size_t)needed + 1, "%s/%s_%s_%d%s", dir,
                     safe_sender, stem, i, ext);
        }
        if (access(candidate, F_OK) != 0) {
            snprintf(out, out_size, "%s", candidate);
            free(candidate);
            return 0;
        }
        free(candidate);
    }

    return -1;
}
