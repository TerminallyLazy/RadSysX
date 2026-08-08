---
name: fhir-data-access
description: >-
  FHIR healthcare data access specialist for querying patient records,
  demographics, medications, and clinical resources. Use when the query
  needs patient-specific data from FHIR servers.
---

# FHIR Data Access

Guide for querying FHIR (Fast Healthcare Interoperability Resources) servers
to access patient and clinical data.

## Available FHIR Tools

| Tool | Description | Input Format |
|------|-------------|--------------|
| `list_fhir_resources` | List available resource types | No input |
| `get_patient_demographics` | Get patient info | Patient ID string |
| `get_medication_list` | Get patient medications | Patient ID string |
| `search_fhir_resources` | Search any resource | `ResourceType?param=value` |

## Search Query Format

The `search_fhir_resources` tool accepts queries in FHIR search format:

```
ResourceType?parameter=value&parameter2=value2
```

### Common Resource Types and Parameters

| Resource | Common Parameters | Example |
|----------|------------------|---------|
| Patient | name, birthdate, gender | `Patient?name=Smith` |
| Medication | code, status | `Medication?code=123456` |
| MedicationRequest | patient, status | `MedicationRequest?patient=123` |
| Condition | patient, code | `Condition?patient=123` |
| Observation | patient, code, date | `Observation?patient=123&code=8867-4` |
| AllergyIntolerance | patient | `AllergyIntolerance?patient=123` |

## Test Data

For testing, use these patient IDs:
- `example` — default test patient
- `test` — alternative test patient

## Error Handling

- If a patient ID is not found, the tool returns an error message
- If the FHIR server is unavailable, tools return connection error details
- Empty results indicate no matching records, not necessarily an error

## When FHIR Data Is Unavailable

If MCP/FHIR integration is disabled, agents should:
1. Acknowledge that patient data is not available
2. Provide general guidance based on the query content
3. Note what additional data would improve the response
