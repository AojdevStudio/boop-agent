# Harden execution agents before Local Messages

Local Messages will expose the user's real local Messages.app inbox to Boop, so it must not be added into an execution environment with broad implicit local shell or filesystem access. We decided execution-agent built-in tool permissions are a prerequisite: before shipping Local Messages, worker agents should be restricted to the explicit tools/integrations needed for a task rather than relying on `allowedTools` plus `bypassPermissions`. This keeps local inbox access as a scoped integration instead of compounding existing local-agent risk.
