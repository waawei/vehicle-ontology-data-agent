# Skills

Skills tell Pi Agent how to interpret a bounded business scenario and when to
call available tools. They do not grant database access, define organization
scope, or authorize a physical field.

The public `vehicle-domain` Skill covers only the capabilities published by the
synthetic registries: short-rental order count, long-rental vehicle count,
supplier grouping, and business-month comparison.

When extending it:

1. publish and test the semantic metric and controlled physical binding first;
2. add a deterministic server-side executor and response contract;
3. expose only the semantic tool surface to Pi Agent;
4. add routing guidance after the tool is executable;
5. keep unavailable scenarios explicit instead of prompting the model to infer
   data that no governed tool can return.

A Skill prompt is guidance, not a security boundary. Every invariant must also
be enforced by the data service.
