/*
 * Test fixture for the native loader checks -- NOT libpolycall.
 *
 *   cc -shared -fPIC -o libfake10.so  fake_polycall.c              a 1.0-style library:
 *                                                                   no binding ABI v1 symbols
 *   cc -shared -fPIC -DFAKE_ABI=2 -o libfakeabi2.so fake_polycall.c every ABI v1 symbol, but
 *                                                                   polycall_ffi_abi_version() == 2
 *
 * node-polycall's loader must refuse both with a clear error and never call
 * anything else in them (every stub below fails loudly if it is called).
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#if defined(_WIN32)
#define FAKE_API __declspec(dllexport)
#else
#define FAKE_API __attribute__((visibility("default")))
#endif

FAKE_API const char *polycall_get_version(void) { return "1.0.0"; }

#ifdef FAKE_ABI
FAKE_API int polycall_ffi_abi_version(void) { return FAKE_ABI; }
FAKE_API int polycall_ffi_version(char *buf, int len) { (void)buf; (void)len; abort(); }
FAKE_API const char *polycall_strerror(int status) { (void)status; abort(); }
FAKE_API int polycall_last_error(char *buf, size_t cap) { (void)buf; (void)cap; abort(); }
FAKE_API int polycall_ffi_run_config(const char *path, int run) { (void)path; (void)run; abort(); }
FAKE_API int polycall_ffi_describe(const char *path, char *buf, int len)
{
    (void)path; (void)buf; (void)len;
    abort();
}
FAKE_API int polycall_call(const char *e, const char *s, const char *o, const char *i, uint32_t t,
                           char *out, size_t cap, size_t *len)
{
    (void)e; (void)s; (void)o; (void)i; (void)t; (void)out; (void)cap; (void)len;
    abort();
}
#endif
