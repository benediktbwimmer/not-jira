# Unblock Prism App

This package defines Unblock's hosted backend shape as a Prism-native app.

The durable facts are Prism objects, relations, and task tag assignments. Derived task state is expressed with runtime-v2 graph closure plus TypeScript-authored materialized surfaces. Labels use Prism tags directly instead of a separate label object and join relation.

The `PrismStore` adapter is cache-free: writes submit Prism semantic commits over runtime v2 gRPC, row reads come from materialized surfaces, and label reads use Prism's tag indexes.

Instruction, view, and feed selectors are represented as catalog rows with compiled fragment identifiers. The Unblock API server can register those fragment uses against Prism's runtime query-fragment compiler, using `taskReadModel` and the graph summary surfaces as the target data shape.

The local SQLite backend remains the small-machine option in `@unblock/core`; this package is the hosted backend model.
