# Miscellaneous

<details>
<summary>1. What are the main problems with using inheritance in object-oriented design?</summary>
Inheritance creates several structural problems that compound as a codebase grows:

**Tight coupling** — child classes depend heavily on the parent's implementation. This is the tightest form of coupling possible in OOP; changes to a parent ripple unpredictably into children.

**Fragile base class** — modifying a base class can silently break descendant classes, including ones in third-party code you don't control.

**Inflexible hierarchy** — single-ancestor taxonomies eventually fail to model new use cases. Real-world concepts rarely fit a strict tree.

**Duplication by necessity** — when the hierarchy can't be extended to cover a new case, developers copy-paste instead, causing divergent parallel class structures.

**Gorilla/banana problem** — you wanted a banana (one method or property) but got a gorilla holding the banana and the entire jungle (the full inherited context and state of every ancestor class).

```js
class Animal {
  constructor(name) {
    this.name = name;
  }
  eat() {
    return `${this.name} eats`;
  }
}

class Dog extends Animal {
  // Dog now carries Animal's full internal state and any future changes to it.
  // Adding a "speak" method to Animal later could silently conflict with Dog.
}
```

Gotcha: These problems don't appear immediately — they compound over time. Small hierarchies feel clean; deep or wide ones become rigid and fragile. Composition over inheritance is the standard alternative.

</details><br>

<details>
<summary>2. What is function composition, and how does it appear in everyday JavaScript?</summary>
Function composition is the process of applying a function to the output of another function, chaining transformations so that data flows through a sequence of steps.

In JavaScript you are composing whenever you: chain array methods, chain promise `.then()` calls, save the return value of one function and pass it into another, or call two methods in sequence using `this` as implicit input.

```js
// Explicit composition: output of one becomes input of the next
const add1 = (x) => x + 1;
const double = (x) => x * 2;

const result = double(add1(3)); // 8

// Array method chaining — also composition
const total = [1, 2, 3]
  .filter((x) => x > 1)
  .map((x) => x * 2)
  .reduce((acc, x) => acc + x, 0); // 10

// Promise chaining — also composition
fetch("/api/user")
  .then((res) => res.json())
  .then((user) => user.name);
```

Gotcha: Composition only works cleanly when each function takes one input and returns one output of a compatible type. Functions with side effects or inconsistent return types break the chain.

</details><br>

<details>
<summary>3. What is the difference between pipe and compose in function composition?</summary>
Both `pipe` and `compose` combine a list of functions into a single function, but they differ in execution order.

`pipe` applies functions left to right — the first function in the list runs first. This matches natural reading order and is generally easier to reason about.

`compose` applies functions right to left — the last function in the list runs first. This mirrors mathematical function notation: `compose(f, g)(x)` = `f(g(x))`.

```js
const pipe =
  (...fns) =>
  (input) =>
    fns.reduce((acc, fn) => fn(acc), input);
const compose =
  (...fns) =>
  (input) =>
    fns.reduceRight((acc, fn) => fn(acc), input);

const add1 = (x) => x + 1;
const double = (x) => x * 2;

pipe(add1, double)(3); // add1 first → 4, then double → 8
compose(add1, double)(3); // double first → 6, then add1 → 7
```

Gotcha: The only difference is `reduce` vs `reduceRight`. In practice most codebases pick one convention and stick to it. `pipe` is more common in JavaScript because left-to-right order matches how developers read code.

</details><br>

<details>
<summary>4. How do you add logging/tracing inside a function composition pipeline?</summary>
Insert a trace utility function between steps in the pipeline. The trace function logs the current value and returns it unchanged, so it acts as a transparent pass-through that doesn't break the data flow.

```js
const trace = (label) => (value) => {
  console.log(`${label}: ${value}`);
  return value; // must return value to keep the pipeline flowing
};

const pipe =
  (...fns) =>
  (input) =>
    fns.reduce((acc, fn) => fn(acc), input);

const add1 = (x) => x + 1;
const double = (x) => x * 2;

const run = pipe(
  add1,
  trace("after add1"), // logs intermediate value
  double,
  trace("after double"), // logs final value
);

run(3);
// "after add1: 4"
// "after double: 8"
```

Gotcha: trace must always return the value it receives. Forgetting the return statement causes `undefined` to propagate through the rest of the pipeline silently.

</details><br>

<details>
<summary>5. What are the three core principles of lambda calculus, and how do they map to JavaScript?</summary>
Lambda calculus is the mathematical foundation of functional programming. It defines three rules about functions:

1. Functions are always anonymous. A function has no inherent name — it is a value that can be assigned, passed, or returned. Naming is a separate concern handled by the surrounding language.

2. Functions are unary — they accept exactly one input. Multiple parameters are simulated by returning a new function for each additional argument. This transformation from an n-ary function to a chain of unary functions is called currying.

3. Functions are first-class values. A function can be passed as an argument to another function and can be returned as a result. This is what makes higher-order functions possible.

```js
// 1. Anonymous function — the expression on the right has no name
const sum = (x, y) => x + y;
//           ↑ this part is the anonymous function value

// 2. Currying — binary function rewritten as two unary functions
const curriedSum = (x) => (y) => x + y;
curriedSum(3)(4); // 7

// 3. First-class — functions passed and returned freely
const apply = (fn) => (x) => fn(x);
const double = (x) => x * 2;
apply(double)(5); // 10
```

Gotcha: JavaScript does not enforce any of these rules — multi-parameter functions, named function expressions, and imperative code are all valid. Lambda calculus principles are a design discipline in JS, not a language constraint.

</details><br>

<details>
<summary>6. What functional language features does JavaScript lack compared to pure FP languages?</summary>
Three capabilities exist in dedicated functional languages that JavaScript does not enforce:

Enforced purity — in languages like Haskell, side effects are prohibited by the type system. JavaScript has no such constraint; any function can freely mutate state or perform I/O.

Enforced immutability — some FP languages make mutation impossible at the language level. Instead of modifying a data structure, every operation returns a new one. These languages typically use persistent trie data structures with structural sharing so unchanged parts of a data structure are shared between old and new versions, keeping memory cost low.

Recursion as the only iteration primitive — in languages like Erlang or pure Haskell, there are no `for`, `while`, or `do` loop statements. All iteration is expressed through recursion. JavaScript has both loops and recursion but enforces neither.

```js
// JavaScript allows all of these — a pure FP language would not:
let x = 1;
x = 2; // mutation — forbidden in enforced immutability
const arr = [1, 2, 3];
arr.push(4); // side effect on existing structure
for (let i = 0; i < 3; i++) {} // loop — forbidden where recursion is the only option
```

Gotcha: JavaScript libraries like Immutable.js and Ramda can simulate these constraints, but they are opt-in conventions, not language-level guarantees.

</details><br>

<details>
<summary>7. What is a higher-order function and what are its common use cases?</summary>
A higher-order function is any function that takes one or more functions as arguments, returns a function, or both.

Common use cases:

- Abstracting control flow using callbacks, promises, or monads
- Building utilities that operate over a wide variety of data types
- Partial application and currying for reuse and composition
- Combining a list of functions into a composed pipeline

```js
// Takes a function as argument
const double = (x) => x * 2;
[1, 2, 3].map(double); // [2, 4, 6]

// Returns a function (partial application)
const multiply = (a) => (b) => a * b;
const triple = multiply(3);
triple(5); // 15

// Combines functions into a pipeline
const compose =
  (...fns) =>
  (x) =>
    fns.reduceRight((acc, fn) => fn(acc), x);
const process = compose(
  (x) => x * 2,
  (x) => x + 1,
);
process(4); // 10
```

Gotcha: Returning a new function every call (e.g. inside a render loop) creates a new function reference each time. This can break reference equality checks in frameworks like React, causing unnecessary re-renders.

</details><br>

<details>
<summary>8. What is a Functor?</summary>
A functor is a container that wraps a value and exposes a `map` method. Calling `map(fn)` applies the function to the wrapped value and returns a new functor of the same type — the structure is always preserved, never broken.

Functors must obey two laws:
Identity: `functor.map(x => x)` must equal the original functor.
Composition: `functor.map(f).map(g)` must equal `functor.map(x => g(f(x)))`.

JavaScript arrays and resolved promises are built-in functors (`Array.map`, `Promise.then`).

```js
class Maybe {
  constructor(value) {
    this.value = value;
  }
  static of(value) {
    return new Maybe(value);
  }
  isNothing() {
    return this.value === null || this.value === undefined;
  }
  map(fn) {
    return this.isNothing() ? Maybe.of(null) : Maybe.of(fn(this.value));
  }
  unwrap() {
    return this.value;
  }
}

// Safe chaining — null never causes a runtime error
Maybe.of("hello")
  .map((s) => s.toUpperCase()) // Maybe("HELLO")
  .map((s) => s.length) // Maybe(5)
  .unwrap(); // 5

Maybe.of(null)
  .map((s) => s.toUpperCase()) // Maybe(null) — no throw
  .unwrap(); // null
```

Gotcha: A functor must always return the same type from `map`. If `map` sometimes returns a plain value and sometimes a wrapped one, the composition and identity laws break and chaining becomes unpredictable.

</details><br>

<details>
<summary>9. Do function parameters with default values count toward a function's `.length` property?</summary>
No. `Function.length` reports only the number of parameters before the first one with a default value. Parameters with defaults, rest parameters, and destructured parameters with defaults are all excluded.

```js
const a = (x, y, z) => {};
a.length; // 3

const b = (x, y = 10, z) => {};
b.length; // 1 — only x counts; y has a default, z comes after it

const c = (x, ...rest) => {};
c.length; // 1 — rest parameters are excluded

const d = () => {};
d.length; // 0
```

Gotcha: This matters in functional patterns like automatic currying, where the arity of a function is inferred from `.length`. A curried utility will miscount a function's expected arguments if any of them have defaults.

</details><br>

<details>
<summary>10. What is an endofunctor?</summary>

An endofunctor is a functor that maps from a category back to the same category.

A regular functor maps between two different categories: X → Y
An endofunctor maps a category to itself: X → X

Monads are endofunctors. This is the basis of the saying: "A monad is just a monoid in the category of endofunctors."

In practical terms, when you use `Array.map` and get back an `Array`, or `Promise.then` and get back a `Promise`, the functor is mapping within the same category — making it an endofunctor.

</details><br>

<details>
<summary>11. What are the core ideas of category theory relevant to functional programming?</summary>

Category theory provides the mathematical foundation for composition in functional programming.

A category consists of:

- Objects (types in code)
- Arrows / morphisms (functions between types)

Three laws must hold:

1. Closure: if there is a → b and b → c, there must also be a direct a → c (via composition)
2. Identity: every object has an identity arrow that returns the object unchanged
3. Associativity: composition order doesn't matter for the result — (f ∘ g) ∘ h = f ∘ (g ∘ h)

```js
const compose = (f, g) => (x) => f(g(x));

const identity = (x) => x;

const double = (x) => x * 2;
const inc = (x) => x + 1;

const doubleAfterInc = compose(double, inc);
doubleAfterInc(3); // 8

// identity law
compose(identity, double)(3) === double(3); // true
```

Every arrow can be understood as a composition, including compositions with the identity arrow.

</details><br>

<details>
<summary>12. What is a monad?</summary>

A monad is a pattern for composing functions that carry context alongside their return value — such as optionality, asynchrony, error states, or side effects.

The three levels of mapping:

- Plain function: `a => b`
- Functor: `Functor(a) => Functor(b)` (maps with context preserved)
- Monad: `Monad(Monad(a)) => Monad(b)` (flattens and maps with context)

The key operations are:

- `lift` (also called `of` / `unit`): wraps a value into the monadic context — `a => M(a)`
- `map`: applies a function inside the context — `M(a) => M(b)`
- `flatten` (also called `join`): removes one layer of context — `M(M(a)) => M(a)`
- `flatMap` / `chain`: flatten + map combined — `M(M(a)) => M(b)`

```js
const x = 20;
const f = (n) => n * 2;

const arr = Array.of(x); // lift: wraps 20 into [20]
const result = arr.map(f); // map: [40]
// Array here is the monadic context

// flatMap prevents double-wrapping:
[[1], [2], [3]].flatMap((x) => x); // [1, 2, 3]
```

Gotcha: Promises are not strictly monads. `Promise.resolve(Promise.resolve(42))` collapses to a single Promise, but only because of special-case logic — not a consistent `flatten` implementation.

</details><br>

<details>
<summary>13. What are the components that make up a monad?</summary>

A monad is built from a symmetry between wrapping and unwrapping a value in a context, combined with the ability to map over it.

Core operations:

- `of` / `unit` / `lift`: wraps a value into the monad — `a => M(a)`
- `join` / `flatten`: unwraps one layer of context — `M(M(a)) => M(a)`
- `map`: transforms the value inside the context — `M(a) => M(b)`
- `chain` / `flatMap` / `bind`: map then flatten — `M(M(a)) => M(b)`

The `map` method can be derived from `chain` and `of`:

```js
const MyMonad = (value) => ({
  of(a) {
    return MyMonad(a);
  },
  chain(f) {
    return f(value);
  },
  map(f) {
    // map = chain + re-lift
    return this.chain((a) => MyMonad.of(f(a)));
  },
});

const m = MyMonad(5);
m.map((x) => x * 2); // MyMonad(10)
```

Gotcha: Many monad implementations omit `.map()` from their public API entirely, since it can always be reconstructed from `chain` and `of`.

</details><br>

<details>
<summary>14. What are the key principles of functional programming?</summary>

**1. Pure Functions**
Same input always produces same output; no side effects (no mutations outside the function, no I/O). Enables safe caching, testing, and composition.

```js
// Pure
const add = (a, b) => a + b;

// Impure — depends on external state
let count = 0;
const inc = () => count++;
```

**2. Idempotence**
Calling a function multiple times with the same input produces the same result. Note: idempotent functions can still have side effects (e.g., HTTP PUT).

**3. Referential Transparency**
Any expression can be replaced with its evaluated result without changing program behavior. Pure functions guarantee this.

**4. Immutability**
Data is never changed after creation — new values are returned instead.

- Weak immutability: structure/shape is fixed, values may vary
- Strong immutability: both structure and values are fixed

**5. First-Class Functions**
Functions are values: assignable to variables, passable as arguments, returnable from other functions.

**6. Higher-Order Functions**
Functions that accept or return other functions.

```js
const withLogging =
  (fn) =>
  (...args) => {
    console.log("called with", args);
    return fn(...args);
  };
```

**7. Recursion and Tail Recursion**
Functions that call themselves to iterate. Tail recursion places the recursive call as the final operation, allowing engines to optimize it into a loop to avoid stack overflow.

```js
// Tail-recursive
const sum = (n, acc = 0) => (n === 0 ? acc : sum(n - 1, acc + n));
```

**8. Currying, Partial Application, and Memoization**

- Currying: transforms `f(a, b)` into `f(a)(b)`
- Partial application: pre-fills some arguments, returning a function for the rest
- Memoization: caches results of pure functions to skip recomputation

```js
const multiply = (a) => (b) => a * b;
const double = multiply(2);
double(5); // 10
```

**9. Function Composition**
Chains small functions so the output of one feeds the input of the next.

```js
const compose =
  (...fns) =>
  (x) =>
    fns.reduceRight((v, f) => f(v), x);

const process = compose(Math.abs, Math.round, parseFloat);
process("-3.7"); // 4
```

</details><br>

<details>
<summary>15. What are the disadvantages of the Service Locator pattern?</summary>

The Service Locator pattern is an alternative to Dependency Injection where a class fetches its own dependencies from a central registry at runtime, rather than having them passed in explicitly.

The main drawbacks are:

Hidden dependencies: A class's required dependencies are not visible from its constructor or method signatures. You can only discover what a class needs by reading its internals, which makes the codebase harder to understand and navigate.

Global state: The locator itself is typically a static or globally accessible object. This creates implicit shared state across the application, leading to tight coupling and unpredictable behavior when the registry is modified.

Harder to test: Because dependencies are pulled internally rather than injected, replacing them with mocks or stubs in unit tests requires manipulating the global locator — adding test setup friction and risk of state leaking between tests.

Less explicit than Dependency Injection: DI frameworks (e.g., Spring, Dagger, InversifyJS) require consumers to declare their dependencies up front, making contracts clear. Service Locator hides that contract, which is why DI is generally preferred in larger codebases.

```js
// Service Locator — dependency is hidden inside the class
class OrderService {
  process() {
    const db = ServiceLocator.get("database"); // hard to see, hard to mock
    db.save(order);
  }
}

// Dependency Injection — dependency is explicit and injectable
class OrderService {
  constructor(db) {
    // visible, mockable
    this.db = db;
  }
  process() {
    this.db.save(order);
  }
}
```

Gotcha: Service Locator is not inherently wrong — it can be useful in plugin systems or legacy code — but it should be used deliberately, not as a default.

</details><br>

<details>
<summary>16. What is a known structural limitation of Swagger (OpenAPI) for API documentation?</summary>

Swagger (OpenAPI) is designed around RESTful API conventions: it assumes that distinct operations are expressed through distinct URL paths and HTTP methods.

Because of this, Swagger cannot adequately document APIs that use a single URL with a single HTTP method for all operations — which is the pattern used by Level 0 APIs in the Richardson Maturity Model.

The most common example is JSON-RPC, where every call is a POST to one endpoint (e.g., /api), with the operation name encoded in the request body. Swagger has no mechanism to describe or differentiate these operations at the spec level.

```
// JSON-RPC style — one URL, one method, operation in body
POST /api
{ "method": "getUser", "params": { "id": 1 } }

POST /api
{ "method": "deleteUser", "params": { "id": 1 } }

// OpenAPI style — operations mapped to distinct paths/methods
GET  /users/{id}
DELETE /users/{id}
```

Gotcha: This is a structural mismatch, not a bug. If your API follows JSON-RPC or a similar RPC-over-HTTP convention, consider alternatives like the OpenRPC specification for documentation.

</details><br>

<details>
<summary>17. What is the purpose of the Address Resolution Protocol (ARP)?</summary>

ARP resolves a known Layer 3 (Network layer) IP address to the corresponding Layer 2 (Link layer) MAC address so that a frame can be delivered over a local network.

When a device wants to send data to an IP address on the same local network, it knows the destination IP but needs the destination MAC address to construct the Ethernet frame. ARP handles this lookup.

The process:

1. The sender broadcasts an ARP request: "Who has IP x.x.x.x?"
2. The device with that IP replies with its MAC address.
3. The sender caches the result in its ARP table for future use.

```
Device A wants to reach 192.168.1.5:

ARP Request (broadcast):
  "Who has 192.168.1.5? Tell 192.168.1.1"

ARP Reply (unicast):
  "192.168.1.5 is at AA:BB:CC:DD:EE:FF"

Device A now builds the Ethernet frame using that MAC address.
```

Key constraints:

- ARP operates only within a single local network segment — it is not routed.
- Inverse ARP (InARP) does the reverse: resolves a known MAC to an IP address.

Gotcha: When traffic crosses a router, ARP is used at each hop to resolve the next-hop MAC, not the final destination MAC.

</details><br>

<details>
<summary>18. What is ARP spoofing and what can an attacker achieve with it?</summary>

ARP spoofing (also called ARP poisoning) is an attack where a malicious device sends forged ARP replies to associate its own MAC address with a legitimate device's IP address.

Because ARP has no authentication — any device can reply to an ARP request or send unsolicited ARP replies — the receiving device simply updates its ARP cache with whatever it receives.

Once the victim's ARP cache maps the target IP to the attacker's MAC, traffic intended for the target is sent to the attacker instead.

```
Normal ARP table on victim:
  192.168.1.1 (router) → AA:BB:CC:DD:EE:FF  (legitimate MAC)

After ARP spoofing:
  192.168.1.1 (router) → 11:22:33:44:55:66  (attacker's MAC)

All traffic to the router now flows through the attacker.
```

Common attack goals:

- Man-in-the-middle (MITM): attacker intercepts and optionally modifies traffic between two hosts
- Denial of service: attacker drops the traffic rather than forwarding it

Gotcha: ARP spoofing is distinct from an ARP proxy, which is a legitimate technique where a router intentionally responds to ARP requests on behalf of another network. Detection tools (like arpwatch or dynamic ARP inspection on managed switches) exist, but ARP itself has no built-in protection mechanism.

</details><br>
