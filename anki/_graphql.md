# GraphQL

<details>
<summary>1. What are the type categories in GraphQL?</summary>

GraphQL uses a type system to describe the shape of all data available in an API. Every field and argument in a GraphQL schema has an explicit type.

The main type categories are:

**Scalar types**: Represent leaf values — primitives with no sub-fields. Built-in scalars are Int, Float, String, Boolean, and ID. Custom scalars (e.g., Date, URL) can be defined.

**Enum types**: A scalar restricted to a fixed set of named values.

**Object types**: The core building block. Describes an entity with a set of named fields, each with its own type.

**Interface types**: An abstract type defining a set of fields that multiple object types must implement.

**Union types**: A type that can resolve to one of several object types, without requiring shared fields.

**Input types**: Like object types, but used exclusively as arguments in queries or mutations (not as return values).

**List types**: A wrapper indicating a field returns an array of a given type — written as [Type].

Two special root types exist:

**Query type**: defines all available read operations (entry points for fetching data).

**Mutation type**: defines all available write operations.

```graphql
scalar Date

enum Status {
  ACTIVE
  INACTIVE
}

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  name: String!
  status: Status!
  createdAt: Date
}

union SearchResult = User | Post

input CreateUserInput {
  name: String!
  status: Status!
}

type Query {
  user(id: ID!): User
  search(term: String!): [SearchResult]
}

type Mutation {
  createUser(input: CreateUserInput!): User
}
```

Gotcha: Input types and object types look similar but are not interchangeable. You cannot use an object type as a mutation argument — you must define a separate input type for that purpose.

</details><br>

<details>
<summary>2. What are queries in GraphQL and how are they structured?</summary>

A query is a read-only message sent from a client to a GraphQL server requesting specific data. The client defines exactly which fields it wants, their nesting hierarchy, and any arguments — the server returns only what was asked for.

```graphql
query {
  user(id: "1") {
    name
    email
    posts {
      title
    }
  }
}
```

Gotcha: Unlike REST, where the server determines the response shape, GraphQL gives the client full control. This eliminates over-fetching (getting unused fields) and under-fetching (needing multiple requests to get all required data).

</details><br>

<details>
<summary>3. What are mutations in GraphQL?</summary>

A mutation is a client message used to perform write operations — creating, updating, or deleting data in a database, cache, or other storage. Mutations are the GraphQL equivalent of POST, PUT, PATCH, and DELETE in REST.

Like queries, mutations can specify exactly which fields to return after the operation completes.

```graphql
mutation {
  createUser(name: "Alice", email: "alice@example.com") {
    id
    name
  }
}
```

Gotcha: Queries are assumed to be side-effect-free and can be executed in parallel. Mutations are executed serially — one after another — because order of side effects matters.

</details><br>

<details>
<summary>4. What are resolvers in GraphQL?</summary>

Resolvers are functions that provide the actual data for each field in a GraphQL schema. When a query or mutation is executed, GraphQL calls the corresponding resolver for each field to fetch or compute its value.

Each resolver receives four arguments: the parent object, the field's arguments, a shared context object (e.g., auth info, DB connection), and metadata about the field.

```js
const resolvers = {
  Query: {
    user: (parent, { id }, context) => context.db.getUserById(id),
  },
  Mutation: {
    createUser: (parent, { name }, context) => context.db.insertUser({ name }),
  },
  User: {
    // Field-level resolver — runs for every User object returned
    fullName: (parent) => `${parent.firstName} ${parent.lastName}`,
  },
};
```

Gotcha: If no resolver is defined for a field, GraphQL uses a default resolver that simply returns the property of the same name from the parent object. This means you only need to write resolvers for fields that require custom logic.

</details><br>

<details>
<summary>5. What is a schema in GraphQL and what role does it play?</summary>

The schema is the central contract of a GraphQL API. It ties together all types, queries, mutations, and resolvers into a single definition that describes every operation a client can perform and every shape of data that can be returned.

It serves as both the API's documentation and its enforcement layer — GraphQL validates every incoming request against the schema before any resolver runs.

```graphql
type User {
  id: ID!
  name: String!
}

type Query {
  user(id: ID!): User
  users: [User!]!
}

type Mutation {
  createUser(name: String!): User
}
```

```js
const { ApolloServer } = require("@apollo/server");

const server = new ApolloServer({ typeDefs, resolvers });
```

Gotcha: The schema is the source of truth. If a type or field is not defined in the schema, it cannot be queried — even if a resolver for it exists.

</details><br>

<details>
<summary>6. Can a GraphQL client query the schema itself rather than application data?</summary>

Yes. GraphQL has a built-in introspection system that allows clients to query the schema as if it were data. This is how tools like GraphiQL, Apollo Studio, and code generators discover available types and operations.

Introspection queries use reserved fields starting with `__`.

```graphql
# List all types in the schema
query {
  __schema {
    types {
      name
      kind
    }
  }
}

# Inspect a specific type
query {
  __type(name: "User") {
    fields {
      name
      type {
        name
      }
    }
  }
}
```

Gotcha: Introspection is enabled by default but is often disabled in production APIs to avoid exposing schema structure to potential attackers.

</details><br>

<details>
<summary>7. What are the common challenges when using GraphQL?</summary>

**Authorization**: GraphQL has no built-in access control. Authorization logic must be implemented manually — either inside resolvers or via middleware. JWT is commonly used for identifying the caller, but field- or role-level permissions are the developer's responsibility.

**N+1 problem**: Nested queries can trigger a separate database call for each item in a list. For example, fetching 100 users and their posts naively results in 101 queries (1 for users + 100 for posts). The standard solution is DataLoader, which batches and caches requests within a single execution cycle.

```js
// Without DataLoader: N+1 queries
User: {
  posts: (user) => db.getPostsByUserId(user.id), // called once per user
}

// With DataLoader: batched into one query
const postLoader = new DataLoader(ids => db.getPostsByUserIds(ids));
User: {
  posts: (user) => postLoader.load(user.id),
}
```

**No built-in versioning**: Unlike REST where you can version via URL (/v1/, /v2/), GraphQL has no versioning mechanism. Schema evolution is handled by deprecating fields and adding new ones alongside old ones.

**Bundle size**: Including a full GraphQL client library (e.g., Apollo Client) adds non-trivial weight to frontend bundles.

**API complexity**: A poorly designed GraphQL schema can be harder to work with than a bad REST API. Schema design requires deliberate thought.

</details><br>

<details>
<summary>8. How do you define a custom scalar type in GraphQL?</summary>

Custom scalars let you define types with their own serialization and validation logic — for example, enforcing that a string is a valid email address or date format.

There are three steps:

1. Declare the scalar in the schema using the `scalar` keyword.
2. Implement the scalar using `GraphQLScalarType`, defining three methods: `parseValue` (deserializes input from variables), `parseLiteral` (deserializes input written inline in a query), and `serialize` (converts the internal value to a JSON-serializable output).
3. Register it in the resolvers map.

```js
// Step 1: schema
// scalar Email
// type User { email: Email! }

const { GraphQLScalarType, Kind } = require('graphql');

// Step 2: implement
const EmailScalar = new GraphQLScalarType({
  name: 'Email',
  description: 'A valid email address string',

  serialize(value) {
    return value; // sent to client
  },

  parseValue(value) {
    if (!/\S+@\S+\.\S+/.test(value)) throw new Error('Invalid email');
    return value; // from variable input
  },

  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new Error('Email must be a string');
    if (!/\S+@\S+\.\S+/.test(ast.value)) throw new Error('Invalid email');
    return ast.value; // from inline literal in query
  },
});

// Step 3: resolvers
const resolvers = {
  Email: EmailScalar,
  Query: { ... },
};
```

Gotcha: All three methods serve different code paths. `parseValue` handles variables (`$email: Email`), `parseLiteral` handles inline values (`email: "alice@example.com"`), and `serialize` handles the outbound response. Omitting any of them can cause silent failures.

</details><br>

<details>
<summary>9. How does GraphQL enum and required/optional field syntax compare to TypeScript?</summary>

Enums are structurally identical between GraphQL and TypeScript, except GraphQL values are separated by whitespace (no commas), while TypeScript uses commas.

```graphql
# GraphQL
enum Role {
  ADMIN
  EDITOR
  VIEWER
}
```

```ts
// TypeScript
enum Role {
  ADMIN,
  EDITOR,
  VIEWER,
}
```

For required vs optional fields, the rules are inverted:

In GraphQL, all fields are nullable (optional) by default. Adding `!` makes a field required.
In TypeScript, all fields are required by default. Adding `?` makes a field optional.

GraphQL also uses no commas or semicolons between field declarations.

```graphql
# GraphQL
type User {
  required: String!
  optional: String
}
```

```ts
// TypeScript
type User = {
  required: string;
  optional?: string;
};
```

Gotcha: The `!` in GraphQL means non-nullable (required). The same symbol in TypeScript means non-null assertion and has nothing to do with schema definitions.

</details><br>

<details>
<summary>10. How does type inheritance in GraphQL differ from TypeScript?</summary>

Both GraphQL and TypeScript support interface-based type contracts, but there are two key differences in GraphQL:

1. The keyword is `implements` in both languages, but GraphQL has no `extends` keyword for types.
2. In GraphQL, every field declared in an interface must be explicitly redeclared in the implementing type. TypeScript does not require this — the interface fields are inherited automatically.

```graphql
# GraphQL — interface fields must be redeclared
interface Node {
  id: ID!
}

type User implements Node {
  id: ID! # must be redeclared
  name: String!
}
```

```ts
// TypeScript — interface fields are inherited, no redeclaration needed
interface Node {
  id: string;
}

class User implements Node {
  // id is inherited — no need to redeclare
  name: string;
}
```

Gotcha: If you forget to redeclare an interface field in GraphQL, the schema will fail validation with an error — it is not silently ignored.

</details><br>

<details>
<summary>11. How do you declare a union type in GraphQL, and can you declare an intersection?</summary>

GraphQL supports union types but has no concept of intersection types.

A union defines a field that can resolve to one of several distinct object types. Unlike interfaces, union members share no required fields.

```graphql
union SearchResult = User | Post | Comment

type Query {
  search(term: String!): [SearchResult]
}
```

On the client side, inline fragments are used to query fields specific to each possible type:

```graphql
query {
  search(term: "alice") {
    ... on User {
      id
      name
    }
    ... on Post {
      id
      title
    }
    ... on Comment {
      id
      body
    }
  }
}
```

Gotcha: All members of a union must be concrete object types — you cannot use scalars, enums, or interfaces as union members. If you need shared fields across types, use an interface instead.

</details><br>

<details>
<summary>12. What is a GraphQL subscription and when is it used?</summary>

A subscription is a GraphQL operation type used for real-time updates. Unlike queries and mutations which follow a request-response cycle, a subscription opens a persistent connection (typically over WebSockets) and pushes data to the client whenever a specified event occurs on the server.

```graphql
# Schema definition
type Subscription {
  userAdded: User
}

# Client operation
subscription OnUserAdded {
  userAdded {
    id
    name
    email
  }
}
```

The operation name (e.g., `OnUserAdded`) is optional but recommended for debugging. The field name (e.g., `userAdded`) must be defined in the schema's `Subscription` type and is backed by a server-side event emitter or pub/sub system.

Gotcha: Subscriptions require different server infrastructure from queries and mutations — a simple HTTP server is not sufficient. Libraries like Apollo Server support subscriptions via a separate WebSocket transport layer.

</details><br>

<details>
<summary>13. How do you declare and use variables in a GraphQL operation?</summary>

Variables allow you to pass dynamic values into a GraphQL query, mutation, or subscription without hardcoding them into the operation string. They are declared in the operation signature and referenced inside the body with a `$` prefix.

```graphql
# Query with a variable
query GetUser($id: ID!) {
  user(id: $id) {
    id
    name
    email
  }
}

# Mutation with a complex variable
mutation CreateUser($input: CreateUserInput!) {
  createUser(input: $input) {
    id
    name
  }
}
```

Variables are sent separately from the operation as a JSON object:

```json
{
  "id": "42"
}
```

Gotcha: Variable types in the declaration must exactly match the argument types in the schema. A mismatch (e.g., passing `String` where `ID!` is expected) will fail schema validation before any resolver runs.

</details><br>

<details>
<summary>14. Can a single GraphQL query trigger multiple resolvers simultaneously?</summary>

Yes. A single GraphQL query can request multiple top-level fields at once, and each field maps to its own resolver. All top-level resolvers in a query are executed in parallel.

```graphql
query {
  users {
    id
    name
  }
  posts {
    id
    title
    author {
      id
      name
    }
  }
}
```

This triggers the `users` resolver and the `posts` resolver in parallel. If the `posts` resolver returns objects with an `author` field that has its own resolver, that nested resolver runs afterward for each post — forming a resolver chain.

Gotcha: Top-level fields in a query run in parallel, but top-level fields in a mutation run serially. This distinction exists because mutations are expected to have side effects where order matters.

</details><br>

<details>
<summary>15. What are GraphQL fragments and what are the two ways to use them?</summary>

Fragments are reusable sets of fields that can be spread into any operation (query, mutation, or subscription) wherever the matching type appears. They reduce repetition when the same field selection is needed in multiple places.

Named fragments are defined separately and referenced with the spread operator `...`:

```graphql
fragment UserFields on User {
  id
  name
  email
}

query GetUsersAndAdmins {
  users {
    ...UserFields
    age
  }
  admins {
    ...UserFields
  }
}
```

Inline fragments are anonymous and written directly inside an operation, typically used when querying a union or interface where the concrete type needs to be checked:

```graphql
query GetSearchResults {
  search(term: "alice") {
    ... on User {
      name
      email
    }
    ... on Post {
      title
      body
    }
  }
}
```

Gotcha: A named fragment is tied to a specific type (`on User`, `on Post`). Attempting to spread a fragment onto a field of a different type will cause a validation error.

</details><br>

<details>
<summary>16. What is a resolver chain in GraphQL and how does the parent argument work?</summary>

A resolver chain occurs when a query requests nested fields, causing GraphQL to execute resolvers in sequence — each passing its return value as the `parent` argument to the next level's resolvers.

Every resolver receives four arguments: `(parent, args, context, info)`. The `parent` argument holds the object returned by the resolver one level up in the hierarchy.

```graphql
# Schema
type Query {
  listing(id: ID!): Listing
}
type Listing {
  id: ID!
  title: String!
  host: User
}
type User {
  id: ID!
  name: String!
}
```

```js
const resolvers = {
  Query: {
    // Step 1: returns { id: "1", title: "Beach House", hostId: "42" }
    listing: (_, { id }, { dataSources }) =>
      dataSources.listingAPI.getListing(id),
  },
  Listing: {
    // Step 2: parent = { id: "1", title: "Beach House", hostId: "42" }
    host: (parent, _, { dataSources }) =>
      dataSources.userAPI.getUser(parent.hostId),
  },
};
```

The execution chain is: `Query.listing` → `Listing.host` → any further nested resolvers on `User`.

Gotcha: If the parent resolver returns an object that already contains the nested field's data (e.g., `host` is already embedded), GraphQL's default resolver will return it automatically without needing an explicit child resolver.

</details><br>

<details>
<summary>17. What is an input type in GraphQL, what can its fields contain, and why is it used?</summary>

An input type is a special object type used exclusively as an argument — most commonly in mutations — to group multiple related parameters into a single structured value. It is defined with the `input` keyword instead of `type`.

```graphql
input CreatePostInput {
  title: String!
  body: String!
  authorId: ID!
}

type Mutation {
  createPost(input: CreatePostInput!): Post
}
```

```graphql
# Client usage
mutation NewPost($input: CreatePostInput!) {
  createPost(input: $input) {
    id
    title
  }
}
```

**Field restrictions**: input type fields may only be scalars, enums, or other input types. Regular object types and interfaces cannot be used as input field types.

It is a common convention to also define a dedicated payload type for the mutation's return value, which can include status metadata alongside the affected data:

```graphql
type CreatePostPayload {
  code: Int!
  success: Boolean!
  message: String!
  post: Post
}
```

Gotcha: Input types and regular object types look nearly identical in syntax but are not interchangeable. Using a regular object type as a mutation argument will cause a schema validation error.

</details><br>

<details>
<summary>18. What are the built-in scalar types in GraphQL?</summary>

GraphQL provides five built-in scalar types that represent primitive leaf values — fields that resolve to a concrete value rather than another object:

**Int**: a signed 32-bit integer (e.g., 5, -100)
**Float**: a signed double-precision floating-point number (e.g., 3.14)
**String**: a UTF-8 character sequence
**Boolean**: true or false
**ID**: a unique identifier, serialized as a string — used to identify objects, not for display

```graphql
type Product {
  id: ID!
  name: String!
  price: Float!
  stock: Int!
  available: Boolean!
}
```

Gotcha: `ID` is always serialized as a string over the wire, even if the underlying value is an integer. Treat it as an opaque identifier — never perform arithmetic or comparisons on it. For domain-specific formats (email, date, URL), define a custom scalar instead.

</details><br>

<details>
<summary>19. When does a GraphQL field need an explicit resolver versus the default resolver?</summary>

GraphQL's default resolver handles a field by looking up a property of the same name on the parent object. It works automatically when the data returned by the parent resolver already contains the field's value directly.

An explicit resolver is required when the field cannot be satisfied by a simple property lookup — most commonly when the data source returns only a reference (like a foreign key ID) instead of the full nested object.

```graphql
type Track {
  title: String! # default resolver works — parent has { title: "..." }
  author: Author! # needs explicit resolver — parent has { authorId: "..." }
  modules: [Module!]! # needs explicit resolver — parent has { id: "..." } only
}
```

```js
const resolvers = {
  Track: {
    author: ({ authorId }, _, { dataSources }) =>
      dataSources.trackAPI.getAuthor(authorId),
    modules: ({ id }, _, { dataSources }) =>
      dataSources.trackAPI.getTrackModules(id),
  },
};
```

Gotcha: GraphQL will not invent missing data. If the parent object doesn't contain the field and no explicit resolver is provided, the field will resolve to null — which will cause an error if the field is declared non-nullable in the schema.

</details><br>

<details>
<summary>20. How does GraphQL execute a query and how do resolved values flow through the tree?</summary>

GraphQL executes a query by walking the selection set as a tree. Each field's resolver runs and returns a value; if that value is an object, it becomes the `parent` for all child field resolvers. This chain continues until every selected field resolves to a scalar, at which point the tree is complete.

```graphql
query {
  track(id: "1") {
    # 1. Query.track runs → returns Track object
    title # 2. Track.title runs with Track as parent → returns String
    author {
      # 3. Track.author runs with Track as parent → returns Author object
      name # 4. Author.name runs with Author as parent → returns String
    }
  }
}
```

```js
const resolvers = {
  Query: {
    track: (_, { id }, { dataSources }) => dataSources.getTrack(id),
  },
  Track: {
    author: ({ authorId }, _, { dataSources }) =>
      dataSources.getAuthor(authorId),
  },
  // title and name use default resolvers — property lookup on parent object
};
```

Gotcha: Resolvers at the same level run in parallel; child resolvers only run after their parent resolves. If a parent resolver returns null, all child resolvers are skipped entirely and silently — a nullable parent type can cause a whole subtree to disappear from the response without an error.

</details><br>

<details>
<summary>21. What are the four parameters in a GraphQL resolver function signature?</summary>

Every GraphQL resolver receives the same four optional arguments:

`parent`: The value returned by the resolver of the parent field. Used to pass data down the resolver chain — for example, a parent object's ID that a child resolver needs to fetch its own data.

`args`: An object containing all GraphQL arguments passed to this field in the operation (e.g., `{ id: "1" }` for a field declared as `user(id: ID!)`).

`contextValue`: A shared object passed to every resolver in a given operation. Used for things that should be globally accessible — authentication state, database connections, or data source instances.

`info`: Metadata about the current execution state, including the field name, the full path from the root, and the return type. Useful for advanced use cases like per-field cache policies.

```js
const resolvers = {
  Query: {
    user: (parent, args, contextValue, info) => {
      console.log(args.id); // argument from the query
      return contextValue.db.getUser(args.id); // shared DB connection
    },
  },
  User: {
    fullName: (parent) => `${parent.firstName} ${parent.lastName}`, // uses parent
  },
};
```

Gotcha: `contextValue` is created fresh per request, not shared across requests. Do not store per-request state anywhere other than `contextValue` — resolver functions may run in parallel and share nothing else.

</details><br>

<details>
<summary>22. What are GraphQL directives and how are they used in queries and schemas?</summary>

Directives are annotations prefixed with `@` that attach metadata or modify behavior at the location where they appear. They can be applied at query execution time (runtime directives) or at schema definition time (schema directives).

The two built-in runtime directives conditionally include or exclude fields:

`@include(if: Boolean)` — include the field only when the condition is true
`@skip(if: Boolean)` — skip the field when the condition is true

```graphql
query GetUser($withEmail: Boolean!) {
  user(id: "1") {
    id
    name
    email @include(if: $withEmail)
  }
}
```

Schema directives annotate type definitions and are commonly used in federation to declare how the schema participates in a supergraph:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.7", import: ["@key"])

type Product @key(fields: "id") {
  id: ID!
  name: String!
}
```

Gotcha: `@skip` and `@include` are evaluated on the client side before the query is sent in some clients, but they are defined as server-side execution directives in the spec. If both are applied to the same field, the field is excluded if either condition triggers exclusion.

</details><br>

<details>
<summary>23. What is a GraphQL supergraph and what does the router do?</summary>

A supergraph is a unified GraphQL API composed of multiple independently deployed services called subgraphs, each owning a distinct slice of the overall schema. Clients interact with a single endpoint and are unaware of the underlying split.

The router is the entry point. It receives the client's query, generates a query plan that breaks the request into sub-queries, dispatches each to the appropriate subgraph, and merges the results into a single response.

```
Client → Router → [Subgraph A (Products), Subgraph B (Reviews), Subgraph C (Users)]
                ↑
         Single composed schema
```

The supergraph schema is a composed artifact generated by a schema composition tool (e.g., Apollo's composition). If any two subgraphs define conflicting types, composition fails and no deployment occurs.

Gotcha: Individual subgraphs can be deployed and updated independently, but their schemas must remain compatible. Breaking changes in one subgraph can fail composition and block all subgraphs from updating until the conflict is resolved.

</details><br>

<details>
<summary>24. What is managed federation in GraphQL and how does the supergraph schema stay current?</summary>

Managed federation is an operational model where a central registry (such as Apollo GraphOS) owns schema composition and distribution. Instead of manually coordinating schema updates across subgraphs, the registry handles composition automatically and pushes the result to the router.

The flow:

1. A developer publishes an updated subgraph schema to the registry.
2. The registry composes all subgraph schemas into a new supergraph schema.
3. If composition succeeds, the new schema is served via Apollo Uplink.
4. The router polls Uplink continuously and hot-reloads the new schema with zero downtime.

```
Developer → Schema Registry → Composition → Uplink → Router (hot-reload)
```

Gotcha: Composition errors are caught at publish time (step 2), not at runtime. This means a bad schema change is blocked before it can affect any live traffic — but it also means a subgraph update can be blocked by an incompatibility with another subgraph it has never directly interacted with.

</details><br>

<details>
<summary>25. What is a GraphQL federation entity and how do multiple subgraphs contribute fields to it?</summary>

A `federation entity` is an object type whose fields are distributed across multiple subgraphs. Each subgraph owns a portion of the type, and the router merges all portions into a single unified type for the client.

Ownership is declared using the `@key` directive, which specifies the primary key field used to identify and resolve instances of that entity across subgraphs. A subgraph that contributes fields to a type it does not own marks the key field as `@external` to indicate it is defined elsewhere.

```graphql
# products subgraph — owns the core type
type Product @key(fields: "id") {
  id: ID!
  name: String!
  price: Float!
}

# reviews subgraph — contributes review fields
type Product @key(fields: "id") {
  id: ID! @external # defined in products subgraph
  reviews: [Review]
  averageRating: Float
}
```

The client queries a single `Product` type and receives fields from both subgraphs merged transparently.

Gotcha: The subgraph contributing fields to an entity it doesn't own must implement a reference resolver — a special resolver that accepts the key and returns the full object — so the router knows how to load it when resolving cross-subgraph queries.

</details><br>

<details>
<summary>26. What is __resolveReference in Apollo Federation and when is it required?</summary>

In Apollo Federation, a GraphQL API is split into multiple subgraphs. When one subgraph needs data from an entity owned by another, it returns a minimal stub called an entity representation — an object with `__typename` and the key field(s). The router forwards that stub to the owning subgraph, which uses `__resolveReference` to hydrate it into a full object.

`__resolveReference` must be defined in every subgraph that owns or contributes fields to an entity. It is not a schema field — it is invisible to clients.

Example with two subgraphs: Posts references a User it doesn't own, Users owns User and resolves it.

```graphql
# Subgraph A (Posts) — schema
type Post {
  id: ID!
  title: String!
  author: User # returns a User stub, not real User data
}

type User @key(fields: "id", resolvable: false) {
  id: ID! # only the key — Posts knows nothing else about User
}
```

```js
// Subgraph A (Posts) — resolvers
const resolvers = {
  Post: {
    author: (post) => ({ __typename: "User", id: post.authorId }),
    // router receives { __typename: "User", id: "42" } and routes to Users subgraph
  },
};
```

```graphql
# Subgraph B (Users) — schema
type User @key(fields: "id") {
  id: ID!
  name: String!
  email: String!
}
```

```js
// Subgraph B (Users) — resolvers
const resolvers = {
  User: {
    // router calls this with the stub { __typename: "User", id: "42" }
    __resolveReference: ({ id }, { dataSources }) =>
      dataSources.userAPI.getUser(id),
  },
};
```

Example with three subgraphs: a third subgraph contributes additional fields to an entity it doesn't own.

```graphql
# Subgraph C (Reviews) — schema
type Location @key(fields: "id") {
  id: ID! @external # key owned by the Locations subgraph
  reviewsForLocation: [Review] # field contributed by Reviews
  overallRating: Float
}
```

```js
// Subgraph C (Reviews) — resolvers
const resolvers = {
  Location: {
    // called with { __typename: "Location", id: "loc-2" } from the router
    __resolveReference: ({ id }, { dataSources }) =>
      dataSources.locationsAPI.getLocation(id),
    reviewsForLocation: ({ id }, _, { dataSources }) =>
      dataSources.reviewsAPI.getReviewsForLocation(id),
  },
};
```

Gotcha: the router can batch multiple entity representations and call `__resolveReference` many times in parallel within a single request. This makes it the natural place to use a DataLoader — without it, each representation triggers a separate database query, recreating the N+1 problem at the federation layer.

</details><br>

<details>
<summary>27. What is an entity representation in Apollo Federation, and what fields does it contain?</summary>

An entity representation is the minimal object a subgraph returns when referencing an entity it does not own. The router uses it to route the request to the correct owning subgraph and identify the specific instance to resolve.

It must contain exactly two things: `__typename` (the concrete type name as a string) and all fields declared in the entity's `@key` directive.

```js
// Posts subgraph — references a User it doesn't own
const resolvers = {
  Post: {
    author: (post) => ({ __typename: "User", id: post.authorId }),
    // Router receives: { __typename: "User", id: "42" }
    // and forwards it to the Users subgraph's __resolveReference
  },
};
```

Gotcha: the key field value must match exactly what the owning subgraph's `__resolveReference` expects. If the owning subgraph uses a composite key (e.g., `@key(fields: "orgId userId")`), the representation must include both fields — omitting either will cause the resolution to fail.

</details><br>

<details>
<summary>28. What are multiple @key directives on a federation entity used for?</summary>

A single entity type can declare multiple `@key` directives, each representing an independent lookup path. This allows different subgraphs to reference the same entity using whichever key field they have available, and the router can use any of them to route a resolution request.

```graphql
type Product @key(fields: "id") @key(fields: "sku") {
  id: ID!
  sku: String!
  name: String!
  price: Float!
}
```

```js
const resolvers = {
  Product: {
    __resolveReference: (ref) => {
      if (ref.id) return db.getProductById(ref.id);
      if (ref.sku) return db.getProductBySku(ref.sku);
    },
  },
};
```

Gotcha: each `@key` is an independent contract. The owning subgraph's `__resolveReference` must be able to handle representations using any of the declared keys, since the router may use any of them depending on which subgraph originated the reference.

</details><br>

<details>
<summary>29. What does @key(resolvable: false) mean in Apollo Federation?</summary>

By default, `@key` on a type implies that the subgraph can resolve the full entity via `__resolveReference`. Setting `resolvable: false` tells the router that this subgraph only uses the key to reference the entity as a return type — it does not contribute fields and cannot resolve the entity itself. No `__resolveReference` is needed or expected.

```graphql
# Subgraph that contributes fields and can resolve the entity
type Location @key(fields: "id") {
  id: ID! @external
  reviewsForLocation: [Review]
  overallRating: Float
}

# Subgraph that only references Location as a return type, contributes nothing
type Location @key(fields: "id", resolvable: false) {
  id: ID!
}
```

```js
// Subgraph contributing fields — needs __resolveReference
const resolvers = {
  Location: {
    __resolveReference: ({ id }, { dataSources }) =>
      dataSources.locationsAPI.getLocation(id),
  },
};

// Subgraph with resolvable: false — no __resolveReference needed
```

Gotcha: omitting `resolvable: false` when you have no `__resolveReference` does not fail at startup. The router will attempt to resolve the entity through that subgraph at query time and fail silently, returning null. Using `resolvable: false` makes the intent explicit and prevents that class of runtime failure.

</details><br>

<details>
<summary>30. What problem does DataLoader solve in GraphQL and how does batching work?</summary>

When GraphQL resolves a list of items with nested fields — for example, fetching the author for each of 10 posts — each field resolver fires independently with no awareness of the others. This causes N+1 queries: one query per item rather than one query for all items.

DataLoader solves this by collecting all `.load(id)` calls that occur within the same event loop tick and invoking the batch function once with all collected IDs, turning N queries into 1.

```js
// 1. Define the loader with a batch function
const userLoader = new DataLoader(async (ids) => {
  const users = await db.query("SELECT * FROM users WHERE id = ANY($1)", [ids]);
  const map = new Map(users.map((u) => [u.id, u]));
  return ids.map((id) => map.get(id) ?? null); // must preserve input order
});

// 2. Attach a new instance to context per request
const server = new ApolloServer({
  context: () => ({
    loaders: { user: new DataLoader(batchUsers) },
  }),
});

// 3. Use in resolvers — all .load() calls in the same tick are batched
const resolvers = {
  Post: {
    author: (post, _, { loaders }) => loaders.user.load(post.authorId),
  },
};
```

DataLoader also deduplicates within a request — if two resolvers call `.load("u1")` in the same tick, only one fetch is made and both receive the same result. Caching and batching are independent and can each be disabled:

```js
new DataLoader(batchFn, { batch: false, cache: false });
```

You can manually bust the cache mid-request after a mutation:

```js
loader.clear("u1"); // clear one key
loader.clearAll(); // clear everything
```

Gotcha: always create a new DataLoader instance per request inside the context factory — never at module level. A shared instance caches results across requests, which leaks data between users.

</details><br>

<details>
<summary>31. When is __resolveType required in GraphQL and what does it do?</summary>

`__resolveType` is required on any abstract type — a union or interface — so the GraphQL runtime can determine which concrete object type a resolved value belongs to. Without it, GraphQL cannot select the correct field resolvers, validate inline fragments, or return a `__typename` for the result.

The function receives the resolved object, context, and info, and must return a string that exactly matches one of the concrete type names declared in the schema.

```graphql
# Schema
union SearchResult = User | Post | Comment

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  username: String!
  email: String!
}

type Post implements Node {
  id: ID!
  title: String!
  body: String!
}

type Comment implements Node {
  id: ID!
  body: String!
}

type Query {
  search(term: String!): [SearchResult]
  node(id: ID!): Node
}
```

```js
const resolvers = {
  // Union — discriminate by shape of the resolved object
  SearchResult: {
    __resolveType(obj) {
      if (obj.username) return "User";
      if (obj.title) return "Post";
      if (obj.body) return "Comment";
      return null; // causes a runtime error — avoid this
    },
  },

  // Interface — same pattern, works across all implementing types
  Node: {
    __resolveType(obj) {
      if (obj.username) return "User";
      if (obj.title) return "Post";
      if (obj.body) return "Comment";
      return null;
    },
  },

  Query: {
    search: (_, { term }, { dataSources }) =>
      dataSources.searchAPI.search(term),
    // returned objects may be Users, Posts, or Comments —
    // SearchResult.__resolveType fires for each one

    node: (_, { id }, { dataSources }) => dataSources.nodeAPI.getById(id),
    // Node.__resolveType fires to determine the concrete type
  },

  User: {
    // field resolvers run only after __resolveType confirms this is a User
    email: (user, _, { dataSources }) => dataSources.userAPI.getEmail(user.id),
  },
};
```

A typical client query using inline fragments, which depend entirely on `__resolveType` working correctly:

```graphql
query {
  search(term: "alice") {
    ... on User {
      id
      username
      email
    }
    ... on Post {
      id
      title
    }
    ... on Comment {
      id
      body
    }
  }
}
```

Gotcha: returning `null` or `undefined` does not silently skip the type — GraphQL throws a runtime error. The returned string is case-sensitive and must match the schema type name exactly; returning `'user'` when the type is `User` will fail. Also, if two types share the same distinguishing field name, the order of checks in `__resolveType` matters — put the most specific checks first.

</details><br>
