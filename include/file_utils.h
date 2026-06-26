#ifndef FILE_UTILS_H
#define FILE_UTILS_H

#include <stddef.h>

int ensure_directory(const char *path);
const char *base_filename(const char *path);
int build_unique_download_path(const char *dir, const char *sender,
                               const char *filename, char *out,
                               size_t out_size);

#endif
