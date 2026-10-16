<details>
<summary>1. In C, what is the difference between printf() and fprintf(), and what header do they require?</summary>

Both functions format text the same way. `printf()` always writes to the standard output stream (`stdout`). `fprintf()` takes the destination stream as its first argument, so it can write to `stdout`, `stderr`, or any `FILE*` you opened with `fopen()`. `printf("x")` is exactly equivalent to `fprintf(stdout, "x")`. Both are declared in `<stdio.h>`, which must be included or the compiler will not know their prototypes.

```c
#include <stdio.h>

int main(void)
{
    printf("to stdout\n");
    fprintf(stdout, "also to stdout\n");
    fprintf(stderr, "error messages go here\n");
    return 0;
}
```

Gotcha: `stderr` is unbuffered, while `stdout` is line-buffered on a terminal and fully buffered when redirected to a file or pipe. Diagnostics written to `stdout` may appear late or interleave unexpectedly with `stderr` output.

</details><br>

<details>
<summary>2. What is the role of .c files versus .h header files in a C project?</summary>

A `.c` file is a translation unit that contains the actual definitions: function bodies and global variable storage. A `.h` header file conventionally contains declarations only: function prototypes, `struct` and `typedef` definitions, macros, and `extern` variable declarations. Other `.c` files include the header to learn the interface without seeing the implementation, and the linker joins the compiled `.c` files together.

```c
/* math_utils.h */
#ifndef MATH_UTILS_H
#define MATH_UTILS_H
int add(int a, int b);        /* declaration only */
extern int call_count;        /* declared here, defined in the .c */
#endif

/* math_utils.c */
#include "math_utils.h"
int call_count = 0;
int add(int a, int b) { call_count++; return a + b; }

/* main.c */
#include <stdio.h>
#include "math_utils.h"
int main(void) { printf("%d\n", add(2, 3)); return 0; }
```

Gotcha: putting a function definition or a non-`extern` variable definition in a header that is included from two `.c` files produces a "multiple definition" linker error. Headers should also use include guards (or `#pragma once`) so including them twice is harmless.

</details><br>

<details>
<summary>3. Which function runs automatically when a C program starts, and what should it return?</summary>

Execution of a hosted C program begins in `main()`. Every other function runs only when something calls it, directly or indirectly, from `main()`. `main()` returns an `int` that becomes the process exit status visible to the shell or parent process: `0` (or `EXIT_SUCCESS`) means success, non-zero (or `EXIT_FAILURE`) means failure.

```c
#include <stdio.h>
#include <stdlib.h>

void helper(void) { puts("called explicitly"); }

int main(void)
{
    helper();
    return EXIT_SUCCESS;
}
```

Gotcha: since C99, reaching the closing brace of `main()` without a `return` statement implicitly returns `0`, but only in `main()`; any other non-`void` function that falls off the end gives undefined behavior when its result is used. Also, `int main()` with empty parentheses historically meant "unspecified parameters"; write `int main(void)` for a clear prototype (C23 made the two forms equivalent).

</details><br>

<details>
<summary>4. Why does a compiled C binary built on one machine often fail to run on a different system?</summary>

A C compiler produces native machine code for a specific target: a CPU architecture (x86-64, ARM64), an operating system and its executable format (ELF on Linux, PE on Windows, Mach-O on macOS), and an ABI including the system C library it links against. A binary matching all of those on the build machine is guaranteed to run there, but the same file cannot run on another OS or architecture, and may fail on the same OS if required shared libraries (for example a newer `glibc`) are missing.

```sh
gcc main.c -o app          # app runs on this OS/arch
file app                   # e.g. "ELF 64-bit LSB pie executable, x86-64"
ldd app                    # shared libraries the binary expects at runtime
```

Gotcha: portability of C is at the source level, not the binary level. To run elsewhere you recompile on the target, or cross-compile with a toolchain for that target. Static linking (`-static`) removes the shared-library dependency but not the OS or architecture dependency.

</details><br>

<details>
<summary>5. What is the difference between #include <file.h> and #include "file.h" in C?</summary>

`#include` is a preprocessor directive that pastes the contents of another file in place before compilation. Angle brackets (`#include <stdio.h>`) search only the system include directories, which is where standard headers like `stdio.h` live. Those headers ship with the compiler and the C library already installed on the machine, so nothing extra needs installing. Double quotes (`#include "utils.h"`) search the directory of the including file first (and any `-I` paths), then fall back to the system directories, so they are used for your own project headers.

```c
#include <stdio.h>        /* standard library header */
#include <string.h>
#include "utils.h"        /* header in the same directory */
#include "../lib/net.h"   /* relative path also works */
```

Gotcha: the preprocessor does textual substitution, so including a header twice defines its contents twice. Protect your headers with include guards or `#pragma once`.

</details><br>

<details>
<summary>6. What does sizeof return in C, and what are the typical sizes of int, float, long, and long long?</summary>

`sizeof` is a compile-time operator that yields the storage size in bytes of a type or expression, as a value of type `size_t`. The C standard only guarantees minimum ranges and ordering (`char` <= `short` <= `int` <= `long` <= `long long`), so exact sizes depend on the platform's data model. On all mainstream 64-bit desktop platforms: `char` is 1, `short` is 2, `int` is 4, `float` is 4, `double` is 8, `long long` is 8, and pointers are 8. The size of `long` differs: 8 bytes on Linux and macOS (LP64 model), but only 4 bytes on 64-bit Windows (LLP64 model).

```c
#include <stdio.h>

int main(void)
{
    printf("int: %zu, float: %zu, long: %zu, long long: %zu, pointer: %zu\n",
           sizeof(int), sizeof(float), sizeof(long), sizeof(long long), sizeof(void *));
    return 0;
}
```

Gotcha: never hard-code these numbers. When you need a specific width, use the fixed-width types from `<stdint.h>` such as `int32_t`, `uint64_t`, and `intptr_t`, and use `sizeof` for everything else. Also, `sizeof` applied to an array parameter in a function gives the size of the pointer, not the array.

</details><br>

<details>
<summary>7. How is a single character literal written in C, and what are the properties of the char type?</summary>

`char` is the smallest addressable type in C, always exactly 1 byte (`CHAR_BIT` bits, 8 on every mainstream platform). A character literal is written in single quotes: `'g'`. Double quotes create a string, which is a different thing: a null-terminated array of `char`. A `char` holds a small integer, so you can compare and do arithmetic with it, for example `'a' + 1` is `'b'` in ASCII.

```c
#include <stdio.h>

int main(void)
{
    char c = 'g';
    char next = c + 1;          /* 'h' */
    printf("%c %c %d %zu\n", c, next, c, sizeof c);   /* g h 103 1 */
    return 0;
}
```

Gotcha: in C a character literal such as `'g'` actually has type `int`, not `char` (unlike C++), so `sizeof 'g'` is 4 on typical platforms while `sizeof c` is 1. Also, whether plain `char` is signed or unsigned is implementation-defined; use `unsigned char` when you handle raw bytes and `signed char` when you need a small signed integer.

</details><br>

<details>
<summary>8. What is size_t in C, how large is it, and where does it come from?</summary>

`size_t` is the unsigned integer type that `sizeof` yields and that the standard library uses for object sizes, element counts, and array indexes, for example in `strlen`, `malloc`, and `fread`. It is defined to be large enough to hold the size of any object, so it is 8 bytes on 64-bit systems and 4 bytes on 32-bit systems. It is declared in `<stddef.h>` and also made available by `<stdio.h>`, `<stdlib.h>`, and `<string.h>`. The `printf` specifier for it is `%zu`.

```c
#include <stdio.h>
#include <stddef.h>
#include <string.h>

int main(void)
{
    size_t n = sizeof(long double);
    size_t len = strlen("hello");
    for (size_t i = 0; i < len; i++)
        ;                                    /* idiomatic index type */
    printf("%zu %zu %zu\n", n, len, sizeof n);   /* e.g. 16 5 8 */
    return 0;
}
```

Gotcha: `size_t` is unsigned, so a loop such as `for (size_t i = n - 1; i >= 0; i--)` never ends because `i` wraps around to `SIZE_MAX` instead of going negative. Comparing a `size_t` with a signed `int` also triggers sign-conversion warnings and surprising results when the `int` is negative.

</details><br>

<details>
<summary>9. What must a C function definition declare up front, and why do callers need a prototype?</summary>

C is statically typed and the compiler processes a file top to bottom. A function definition must state its return type and the type of every parameter. A call site must see either the definition or a prototype (declaration) earlier in the file or via a header, so the compiler knows how to convert arguments and interpret the result.

```c
#include <stdio.h>

int add(int a, int b);           /* prototype */

int main(void)
{
    printf("%d\n", add(2, 3));   /* ok: prototype seen above */
    return 0;
}

int add(int a, int b)            /* definition */
{
    return a + b;
}
```

Gotcha: calling a function with no prior declaration relied on "implicit `int`" declarations in pre-C99 C. C99 (1999) removed implicit function declarations, and since GCC 14 (2024) and Clang 16 (2023) this is a hard error by default rather than a warning, because the guessed signature causes silent miscompiles. Declare a function that takes no arguments as `f(void)`, not `f()`, in code targeting standards before C23.

</details><br>

<details>
<summary>10. How are arguments passed to functions in C, and how do you let a function modify the caller's variable?</summary>

C passes every argument by value: the function receives a copy, and changes to the parameter do not affect the caller. To let a function read or modify the caller's variable, pass a pointer to it (its address, obtained with `&`). Inside the function, `*p` reads or writes the pointed-to value. Note that writing `&p` inside the function gives the address of the local pointer parameter itself, not the caller's variable.

```c
#include <stdio.h>

void add_to(int amount, int *target)
{
    *target += amount;    /* modifies caller's variable */
    amount = 0;           /* only modifies the local copy */
}

int main(void)
{
    int total = 30;
    int step = 20;
    add_to(step, &total);
    printf("%d %d\n", total, step);   /* 50 20 */
    return 0;
}
```

Gotcha: arrays are the exception in appearance only. Passing an array actually passes a pointer to its first element, so the function can modify the caller's array and `sizeof` inside the function gives the pointer size, not the array size. Structs, by contrast, really are copied whole.

</details><br>

<details>
<summary>11. What does the ULL suffix on an integer literal mean in C, and when is it needed?</summary>

An integer literal with no suffix gets the first type from the list `int`, `long`, `long long` that can represent its value (for decimal literals). Suffixes override this: `U` means unsigned, `L` means `long`, `LL` means `long long`, and they combine, so `5ULL` is an `unsigned long long`. The suffix is part of the literal's type, not its numeric value. A value above the signed `long long` maximum (`9223372036854775807`) has no type in the default list, so the compiler warns "integer constant is so large that it is unsigned" and treats it as unsigned anyway; writing `ULL` makes that intent explicit and silences the warning.

```c
#include <stdio.h>
#include <stdint.h>

int main(void)
{
    unsigned long long big = 18446744073709551615ULL;  /* 2^64 - 1 */
    size_t max_index = SIZE_MAX;                       /* preferred portable spelling */
    printf("%llu %zu\n", big, max_index);
    return 0;
}
```

Gotcha: sizes are platform dependent. `long` is 8 bytes on 64-bit Linux and macOS but 4 bytes on 64-bit Windows, while `long long` is at least 8 bytes everywhere. Prefer the constants from `<stdint.h>` and `<limits.h>` (`SIZE_MAX`, `UINT64_MAX`, `INT_MAX`) over typing out magic numbers.

</details><br>

<details>
<summary>12. What do the & and * operators do with memory addresses in C?</summary>

The unary `&` operator yields the address of a variable as a pointer. The unary `*` operator dereferences a pointer, giving access to the value stored at that address. For a multi-byte object, `&` yields the address of its first (lowest) byte; the remaining bytes occupy consecutive addresses. For a 4-byte `int` at `0x7ffc4c38cef0`, its bytes are at `0x7ffc4c38cef0` through `0x7ffc4c38cef3`.

```c
#include <stdio.h>

int main(void)
{
    int t = 42;
    int *p = &t;              /* p holds the address of t */
    printf("%p\n", (void *)p);
    printf("%d\n", *p);       /* 42, read through the pointer */
    printf("%d\n", *(&t));    /* same thing: dereferencing the address of t */
    *p = 7;                   /* writes to t */
    return 0;
}
```

Gotcha: the order in which the bytes of a multi-byte value are laid out is the machine's endianness. x86 and most ARM systems are little-endian, so the lowest address holds the least significant byte.

</details><br>

<details>
<summary>13. Why does printf need format specifiers, and what are the common ones for each C type?</summary>

`printf` is a variadic function: it receives only raw argument values with no type information, so the format string must tell it the type and size of each argument to read it correctly. Common specifiers:

```
%d    int (signed decimal)
%u    unsigned int
%ld   long            %lld  long long
%lu   unsigned long   %llu  unsigned long long
%zu   size_t          %zd   signed counterpart of size_t
%c    char (passed as int)
%s    char * (null-terminated string)
%f    double (float is promoted to double automatically)
%p    void * (pointer, printed in an implementation-defined form, usually hex)
%x    unsigned int in hexadecimal
%hhu  unsigned char as a decimal number
%hhd  signed char as a decimal number
```

The `h` and `hh` prefixes are length modifiers meaning "the argument is a `short` / `char`-sized integer" (`hh` and `z` were added in C99).

```c
#include <stdio.h>

int main(void)
{
    unsigned char byte = 200;
    size_t n = 10;
    int value = 5;
    printf("%hhu %zu %p\n", byte, n, (void *)&value);
    return 0;
}
```

Gotcha: a specifier that does not match the argument type is undefined behavior, not just wrong output. Compile with `-Wall -Wformat` so the compiler checks the format string. Pointer width is platform dependent (64 bits on 64-bit systems, 32 bits on 32-bit systems), and `%p` formally requires a `void *` argument, so cast other pointer types to `(void *)`.

</details><br>

<details>
<summary>14. How do you inspect the individual bytes of a variable in C, and why is a cast to char * needed?</summary>

Because the bytes of an object sit at consecutive addresses, you can walk them with pointer arithmetic. Pointer arithmetic scales by the pointed-to type: adding 1 to an `int *` moves 4 bytes, so to step one byte at a time you cast the address to `unsigned char *` (or `char *`). The C standard explicitly allows character pointers to access the bytes of any object, which makes this the sanctioned way to inspect raw memory.

```c
#include <stdio.h>

int main(void)
{
    unsigned int value = 0x01020304;
    unsigned char *bytes = (unsigned char *)&value;

    for (size_t i = 0; i < sizeof value; ++i)
        printf("byte %zu at %p = %hhu\n", i, (void *)(bytes + i), bytes[i]);
    return 0;
}
```

On a little-endian machine this prints 4, 3, 2, 1, showing the least significant byte stored first.

Gotcha: use `unsigned char` rather than plain `char` for raw bytes, because plain `char` may be signed and a byte like `0xFF` would read as `-1`. Accessing an object's bytes through any other mismatched pointer type (for example reading a `float` through an `int *`) violates strict aliasing and is undefined behavior; use `memcpy` for that.

</details><br>

<details>
<summary>15. How are strings represented in C, and what is the difference between a char array and a pointer to a string literal?</summary>

C has no string type. A string is an array of `char` terminated by the null character `'\0'`; functions such as `printf("%s")` and `strlen` read bytes until they hit that terminator, so the array must have room for it. A string literal `"text"` denotes an array of `char` with the terminator added automatically. A `char` array initialized from a literal owns a writable copy of the characters. A `char` pointer initialized from a literal points at the literal itself, which lives in read-only memory.

```c
#include <stdio.h>
#include <string.h>

int main(void)
{
    char a[5] = "Test";                /* 4 chars + '\0', writable, sizeof a == 5 */
    char b[] = {'T','e','s','t','\0'}; /* same thing written out */
    const char *c = "Yet another";     /* points to a read-only literal */

    a[0] = 'B';                        /* ok */
    printf("%s %s %s %zu\n", a, b, c, strlen(c));   /* strlen returns size_t */
    return 0;
}
```

`strlen` conceptually does this, but optimized:

```c
size_t my_strlen(const char *s)
{
    size_t n = 0;
    while (s[n] != '\0')
        n++;
    return n;
}
```

Gotcha: writing through a non-`const` pointer to a literal (`char *p = "x"; p[0] = 'y';`) compiles in C but is undefined behavior and usually crashes. Declare such pointers as `const char *`; C++ has required this since C++11. Also note that when an array is passed to a function or used in an expression it decays to a pointer to its first element, which is why `printf` receives only the address.

</details><br>

<details>
<summary>16. How do you declare, initialize, and dereference a pointer in C, and why does the pointer have a type?</summary>

A pointer is a variable that holds a memory address. Its declaration names the type of object it points to: `int *p` means "`p` points to an `int`". You initialize it with an address, typically from `&` applied to a variable or from `malloc`, never with a plain value. The type lets the compiler know how many bytes to read on dereference (`*p`) and how far to move on pointer arithmetic (`p + 1`), so you do not have to repeat the type each time you use it.

```c
#include <stdio.h>

int main(void)
{
    int a = 20;
    int *p = &a;        /* declare and point at a */

    printf("%d\n", *p); /* dereference: reads 20 */
    *p = 21;            /* writes through the pointer: a is now 21 */

    double d = 1.5;
    double *q = &d;     /* q + 1 would move 8 bytes, p + 1 moves 4 */
    (void)q;
    return 0;
}
```

Gotcha: a pointer that is declared but never initialized contains garbage; dereferencing it is undefined behavior. Initialize pointers you cannot yet point anywhere to `NULL` and check before use. Also, in the declaration `int *p, q;` only `p` is a pointer; `q` is a plain `int`.

</details><br>

<details>
<summary>17. What is stack memory in C, how is it allocated, and what are its limits?</summary>

The stack is a contiguous region of memory reserved for each thread when the thread starts. It holds function call frames: local variables, parameters, saved registers, and return addresses. Allocation is just moving the stack pointer register down; deallocation is moving it back up when the function returns. There is no bookkeeping and no fragmentation, which is why it costs only a few CPU cycles and why lifetime is automatic: a local variable disappears when its function returns.

```c
void work(void)
{
    int a = 3500;          /* lives on the stack */
    char buf[256];         /* also on the stack */
    (void)a; (void)buf;
}                          /* both freed automatically here */
```

Its size is fixed at thread creation and cannot grow past the limit. Typical defaults: 8 MB for the main thread on Linux (`ulimit -s` shows `8192` KB) and for glibc pthreads, 8 MB for the macOS main thread but 512 KB for secondary threads, and 1 MB on Windows. Exceeding it, through unbounded recursion or a huge local array, causes a stack overflow, which normally crashes the process with a segmentation fault. You can raise the limit with `ulimit -s`, with linker options on Windows, or per thread with `pthread_attr_setstacksize`, but it remains a hard ceiling.

Gotcha: returning a pointer to a local variable is a classic bug, because the memory is reused by the next call. Anything that must outlive the function, or is large or of runtime-determined size, belongs on the heap.

</details><br>

<details>
<summary>18. What is heap memory in C, how is it allocated, and how does it differ from the stack?</summary>

The heap is the pool of memory a program requests at runtime for data whose size or lifetime is not known at compile time. In C you allocate with `malloc`, `calloc`, or `realloc` from `<stdlib.h>` and release with `free`; C++ adds `new` and `delete` on top. The allocator obtains pages from the kernel (on Linux via `brk`/`sbrk` for the data segment or `mmap` for large blocks) and then tracks free and used chunks itself, splitting and merging them. That bookkeeping makes allocation slower than a stack bump and allows fragmentation, but the heap grows on demand and is bounded only by virtual address space and physical RAM plus swap, not by a fixed few megabytes.

```c
#include <stdlib.h>

int main(void)
{
    int *p = malloc(sizeof *p);   /* allocated on the heap */
    if (p == NULL)
        return 1;                 /* allocation can fail */
    *p = 3500;
    free(p);                      /* you must release it yourself */
    p = NULL;
    return 0;
}
```

Comparison:

```
                 Stack                          Heap
Limit            ~1-8 MB per thread, fixed      GBs+, bounded by address space / RAM
Growth           Fixed at thread creation       Grows on demand
Allocation       Pointer bump, a few cycles     brk/mmap + allocator bookkeeping
Lifetime         Ends when the function returns Until free() is called
Failure mode     Stack overflow (crash)         Leak (slow growth), then OOM kill
```

Gotcha: the heap's failures are quieter than the stack's. Forgetting `free` leaks memory, freeing twice or using memory after `free` corrupts the allocator and is undefined behavior. Tools such as Valgrind or compiling with `-fsanitize=address` catch these.

</details><br>

<details>
<summary>19. What does malloc return in C, and how does indexing a typed pointer into that memory work?</summary>

`malloc(n)` reserves `n` bytes on the heap and returns a `void *` to the first byte, or `NULL` on failure. In C a `void *` converts to any object pointer type implicitly, so no cast is needed. Once stored in a typed pointer, the block behaves like an array of that type: `p[i]` is the element at byte offset `i * sizeof(*p)`. With an `int *` (4-byte `int`), `p[0]` covers bytes 0-3 and `p[1]` covers bytes 4-7, so `p[1]` starts at the fifth byte.

```c
#include <stdlib.h>
#include <stdio.h>

int main(void)
{
    size_t count = 3;
    int *nums = malloc(count * sizeof *nums);   /* 12 bytes for three ints */
    if (nums == NULL)
        return 1;

    nums[0] = 10;     /* bytes 0-3 */
    nums[1] = 20;     /* bytes 4-7 */
    nums[2] = 30;     /* bytes 8-11 */
    printf("%d\n", nums[1]);
    free(nums);
    return 0;
}
```

Gotcha: `malloc` does not initialize the memory, so reading before writing yields garbage; use `calloc(count, size)` to get zeroed memory. Indexing past the allocated size (`nums[3]` above) is undefined behavior even though the pointer arithmetic compiles. Casting the result, as in `(int *)malloc(...)`, is only required in C++ and in C can hide a missing `#include <stdlib.h>`.

</details><br>

<details>
<summary>20. What is a struct in C, and how do you define one and access its fields?</summary>

A `struct` groups several variables of different types into one unit with a single name, like a record with named fields. The `struct` declaration is only a blueprint describing the layout; it allocates nothing. You create variables of that type and access fields with the dot operator (`p1.age`), or with `->` when you have a pointer to the struct (`ptr->age`). An array field stores its data inside the struct, while a pointer field stores only an address referring to memory elsewhere.

```c
#include <stdio.h>
#include <string.h>

struct Person {
    char name[50];          /* 50 bytes stored inside the struct */
    const char *surname;    /* pointer to characters stored elsewhere */
    int age;
    float height;
};

int main(void)
{
    struct Person p1;
    snprintf(p1.name, sizeof p1.name, "%s", "Alice");   /* bounded copy */
    p1.surname = "Smith";
    p1.age = 30;
    p1.height = 1.68f;

    struct Person p2 = { .name = "Bob", .surname = "Lee", .age = 25, .height = 1.80f };

    struct Person *ptr = &p1;
    printf("%s %s %d\n", ptr->name, ptr->surname, p2.age);
    return 0;
}
```

Gotcha: in C you must write `struct Person` each time unless you add a `typedef`. Structs are copied by value on assignment and when passed to functions, which copies the array field but only the pointer of the pointer field. Prefer `snprintf` or `strlcpy` over `strcpy` for filling fixed-size `char` arrays, because `strcpy` performs no bounds check and overflows the buffer if the source is too long.

</details><br>

<details>
<summary>21. How does a C program receive its command-line arguments?</summary>

The operating system passes command-line arguments to `main()` through two parameters: `argc` (argument count) is the number of arguments, and `argv` (argument vector, meaning an array) is an array of pointers to null-terminated strings. `argv[0]` is the program name as invoked, `argv[1]` through `argv[argc - 1]` are the user-supplied arguments, and `argv[argc]` is guaranteed to be `NULL`.

```c
#include <stdio.h>

int main(int argc, char *argv[])
{
    for (int i = 0; i < argc; i++)
        printf("Argument %d is: %s\n", i, argv[i]);
    return 0;
}
```

Running `./app hello 42` prints three lines: `./app`, `hello`, and `42`.

Gotcha: every argument arrives as a string, so a number such as `42` must be converted with `strtol` or similar before arithmetic. Always check `argc` before reading `argv[1]`; accessing it when `argc` is 1 dereferences the terminating `NULL`.

</details><br>

<details>
<summary>22. How do you terminate a C process with a specific exit code from anywhere in the program?</summary>

Call `exit(code)` from `<stdlib.h>`. It ends the process immediately from any function, not just `main()`, and the code becomes the exit status seen by the shell or parent (the same as returning that value from `main()`). Use the portable constants `EXIT_SUCCESS` (`0`) and `EXIT_FAILURE`. Before terminating, `exit()` runs any functions registered with `atexit()`, flushes and closes all open stdio streams, and removes files created by `tmpfile()`.

```c
#include <stdio.h>
#include <stdlib.h>

void fatal(const char *msg)
{
    fprintf(stderr, "fatal: %s\n", msg);
    exit(EXIT_FAILURE);
}

int main(void)
{
    FILE *f = fopen("missing.txt", "r");
    if (f == NULL)
        fatal("cannot open file");
    fclose(f);
    return EXIT_SUCCESS;
}
```

Gotcha: `_exit()` (and `_Exit()`) terminate without flushing stdio buffers or running `atexit` handlers, which is what you want in a forked child that must not duplicate the parent's buffered output. Only the low 8 bits of the exit code are visible to the shell on Unix, so codes above 255 wrap around.

</details><br>

<details>
<summary>23. How do you read a stream character by character in C until end of file, and what is EOF?</summary>

`fgetc(stream)` returns the next byte of a `FILE*` stream as an `unsigned char` converted to `int`, or the special value `EOF` (a negative `int`, typically `-1`, defined in `<stdio.h>`) when no more data is available or an error occurred. Because `EOF` must be distinguishable from all 256 possible byte values, the result must be stored in an `int`, not a `char`. A read loop keeps calling `fgetc` until it sees `EOF`.

```c
#include <stdio.h>

int main(void)
{
    int c = fgetc(stdin);
    while (c != EOF)
    {
        fputc(c, stdout);     /* same as fprintf(stdout, "%c", c) */
        c = fgetc(stdin);
    }
    return 0;
}
```

When `stdin` is a terminal, the user signals end of input with Ctrl+D on Unix-like systems (at the start of a line) or Ctrl+Z followed by Enter on Windows. When `stdin` is a file or pipe, `EOF` arrives automatically after the last byte.

Gotcha: storing the result in a `char` makes the loop either never terminate (`unsigned char` can never equal `-1`) or stop early when a legitimate byte `0xFF` is read (`signed char` compares equal to `-1`). After the loop, use `feof(stream)` and `ferror(stream)` to tell a normal end of file from a read error.

</details><br>

<details>
<summary>24. How do you open, write to, flush, and close a file in C, and why might written data not appear immediately?</summary>

`fopen(path, mode)` returns a `FILE*` for the file, or `NULL` on failure. Common modes are `"r"` (read), `"w"` (write, truncate or create), and `"a"` (append). You then use the same functions as for `stdout`, such as `fprintf`, `fputc`, and `fwrite`, passing the `FILE*`. The stdio library buffers output in memory and writes it to the OS only when the buffer fills, when you call `fflush`, or when the stream is closed, which `fclose` does. Normal program exit (`return` from `main` or `exit()`) also flushes all open streams. Until one of those happens, another process looking at the file may not see your data.

```c
#include <stdio.h>

int main(void)
{
    FILE *out = fopen("./dest.txt", "w");
    if (out == NULL)
    {
        perror("fopen");
        return 1;
    }

    fprintf(out, "%c", 'A');
    fflush(out);        /* force buffered data to the OS now */

    fclose(out);        /* flushes and releases the handle */
    return 0;
}
```

Gotcha: if the process crashes or is killed, or ends via `_exit()`, unflushed data is lost, so flush explicitly before long waits or when another process must read the data while you keep writing. Each open `FILE` consumes a file descriptor, so always `fclose` what you `fopen`. `fflush` is guaranteed to hand data to the OS kernel, not necessarily to the physical disk; `fsync(fileno(out))` is needed for that.

</details><br>

<details>
<summary>25. When and how must heap memory be released or resized in C?</summary>

Every block obtained from `malloc`, `calloc`, or `realloc` must be released exactly once with `free(pointer)` when it is no longer needed; otherwise the memory stays reserved until the process exits (a leak), which matters in long-running programs and loops. `realloc(pointer, new_size)` changes the size of an existing block, preserving the old contents up to the smaller of the two sizes; it may move the block to a new address and returns the new pointer, or `NULL` on failure while leaving the original block intact.

```c
#include <stdlib.h>

int main(void)
{
    size_t cap = 4;
    int *data = malloc(cap * sizeof *data);
    if (data == NULL) return 1;

    for (size_t i = 0; i < 10; i++)
    {
        if (i == cap)                               /* grow when full */
        {
            size_t new_cap = cap * 2;
            int *tmp = realloc(data, new_cap * sizeof *data);
            if (tmp == NULL) { free(data); return 1; }   /* old block still valid */
            data = tmp;
            cap = new_cap;
        }
        data[i] = (int)i;
    }

    free(data);
    data = NULL;        /* avoid a dangling pointer */
    return 0;
}
```

Gotcha: never write `data = realloc(data, ...)` directly, because on failure you lose the only pointer to the old block and leak it. After `free`, the pointer still holds the old address but using it is undefined behavior (use-after-free), as is calling `free` twice on the same block. `free(NULL)` is safe and does nothing.

</details><br>

<details>
<summary>26. What does #define do in C, and how does a macro constant differ from a variable?</summary>

`#define` creates a preprocessor macro: a textual find-and-replace rule applied before compilation. Every later occurrence of the macro name is replaced with the replacement text, and the compiler never sees the `#define` line itself. Because it is pure text substitution, there is no type, no `=` sign, and no semicolon; anything after the name becomes part of the replacement. It is commonly used to give a meaningful name to a constant so it can be changed in one place.

```c
#include <stdio.h>

#define MAX_LEN 64              /* correct */
/* #define MAX_LEN = 64;        wrong: "= 64;" would be pasted in */

#define SQUARE(x) ((x) * (x))   /* function-like macro, note the parentheses */

int main(void)
{
    char number[MAX_LEN];       /* compiler sees: char number[64]; */
    printf("%zu %d\n", sizeof number, SQUARE(3 + 1));   /* 64 16 */
    return 0;
}
```

Gotcha: macros ignore scope and types, and unparenthesized macro arguments break operator precedence (without the parentheses above, `SQUARE(3 + 1)` would expand to `3 + 1 * 3 + 1`, which is 7). Where possible prefer typed alternatives: `enum` constants for integers, `static const` variables, or `constexpr` object declarations added in C23 (2024). Note that in C before C23, a `const` variable is not a constant expression and cannot size an array at file scope, which is a main reason `#define` constants remain common.

</details><br>

<details>
<summary>27. What is make, how does a Makefile rule work, and what are the common commands?</summary>

`make` is a build automation tool. It reads a file named `Makefile` consisting of rules of the form `target: dependencies`, followed by indented command lines (the recipe). `make` compares file modification times: if any dependency is newer than the target, or the target does not exist, it runs the recipe to rebuild that target, recursively building dependencies first. Unchanged files are skipped, which saves time on large projects.

```makefile
app: main.o utils.o
	gcc main.o utils.o -o app

main.o: main.c utils.h
	gcc -c main.c

utils.o: utils.c utils.h
	gcc -c utils.c

.PHONY: clean
clean:
	rm -f app *.o
```

Common commands:

```
make             build the default target (the first rule in the file)
make <target>    build a specific target, e.g. make utils.o
make clean       run the clean rule, if defined, to remove build artifacts
make install     run the install rule, if defined, to copy outputs to system dirs
make -j8         build up to 8 independent targets in parallel
```

`make` is not tied to C; a recipe can run any shell command.

Gotcha: recipe lines must be indented with a real tab character, not spaces, or `make` reports "missing separator". Targets such as `clean` that do not produce a file should be declared `.PHONY`, otherwise a file named `clean` in the directory would make the rule appear up to date and never run.

</details><br>
