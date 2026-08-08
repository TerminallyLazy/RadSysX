---
name: clinical-reasoning
description: >-
  Cross-cutting skill for chain-of-thought medical reasoning. Provides
  structured thinking frameworks for clinical decision-making, differential
  diagnosis, and treatment planning. Use alongside any medical agent for
  improved reasoning transparency.
---

# Clinical Reasoning Framework

This skill provides structured reasoning patterns for medical decision-making.
All medical agents should use these patterns to ensure transparent,
evidence-based analysis.

## Chain-of-Thought Pattern

Always structure your reasoning inside `<think></think>` tags before giving
your final answer. This ensures transparency in clinical decision-making.

```
<think>
[Step-by-step reasoning here]
</think>

[Final answer here]
```

## Reasoning Frameworks

### SOAP Format (for patient encounters)
- **S**ubjective: Patient-reported symptoms and history
- **O**bjective: Clinical findings, test results, vital signs
- **A**ssessment: Diagnosis or differential diagnosis
- **P**lan: Treatment, follow-up, monitoring

### Differential Diagnosis
1. List all plausible diagnoses
2. For each, note supporting and opposing evidence
3. Rank by probability
4. Identify "cannot miss" diagnoses (life-threatening conditions)
5. Recommend discriminating tests

### Evidence Hierarchy
When citing evidence, note the level:
1. Systematic reviews / meta-analyses
2. Randomized controlled trials
3. Cohort studies
4. Case-control studies
5. Case series / case reports
6. Expert opinion

## Transparency Requirements

- Distinguish between established facts and clinical judgment
- Acknowledge uncertainty explicitly
- Note when recommendations are based on limited evidence
- Flag areas where expert consultation is advised

See `references/REFERENCE.md` for detailed reasoning templates.
