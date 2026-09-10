# Customer Codex model versions

Status: implemented in dsh-passwords 2.6.31.

Customer accounts may select GPT-5.6 and newer models offered by the Codex provider, including `gpt-6-astra`. The policy compares numeric major and minor versions; it admits future versions such as 5.10 without a new name list. Unrecognized model ids and versions below 5.6 are rejected. Other providers and administrator access keep their existing behavior.

The same predicate filters both model catalogs, authorizes model-selection RPCs, and checks the resolved model in the agent request hook. The catalog preserves the provider's order and metadata; this policy does not invent models missing from that catalog or grant upstream provider access.

Tests cover the numeric version threshold, Astra in customer catalogs, Astra selection in an owned session, rejection of older models, and retained account ownership checks.
