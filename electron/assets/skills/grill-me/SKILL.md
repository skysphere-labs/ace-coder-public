---
name: grill-me
description: Ask sharp clarification questions one at a time, recommend a default answer, and inspect the codebase when the answer is discoverable.
source: https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md
---

# Grill Me

Use this when the user asks to stress-test a plan, architecture, product
decision, or implementation strategy before work starts.

## Rules

- Ask one question at a time.
- Explain why the question matters in one short sentence.
- Provide your recommended answer before waiting for the user.
- If repo inspection can answer the question, inspect the repo instead of asking.
- Stop grilling once the plan has enough clarity to implement safely.
- Do not dump a questionnaire. Walk the decision tree one branch at a time.

## Output Pattern

```text
Question: <one concrete decision>
Why it matters: <risk or dependency>
Recommended answer: <your default and why>
```
