# Native OpenMed workflow adaptations

Implemented 2026-09-23 from the user-requested OpenMed skills `structuring-radiology-reports`, `extracting-dicom-metadata`, and `mining-pubmed-literature` (version 1.0, Apache-2.0). These are native RadSysX adaptations of the workflows, not an installation of OpenMed NER models.

| Workflow | Running RadSysX capability | Boundary |
| --- | --- | --- |
| DICOM metadata | Scoped Codex `series_get_metadata` returns modality, frame count, dimensions, spacing and orientation from the validated OHIF inventory. | Technical allowlist only. No patient names, original UIDs, free-text headers or private tags. Does not claim to audit full DICOM headers, deidentify pixels, or parse SR. |
| Report structure | `structure_radiology_report` identifies literal indication/technique/comparison/findings/impression sections and measurement spans with source hashes and Unicode offsets. The assistant uses the existing visible, reversible `report_draft`; saving still requires review. | Missing sections stay missing. Original negation, uncertainty and laterality remain verbatim. No diagnoses, billing codes or follow-up recommendations are inferred by the extractor. |
| PubMed mining | The existing `ResearchTools.search_pubmed` now supplies labelled abstract sections, journal/date, publication types and MeSH terms, plus query/translation/PMID retrieval receipts. These appear under **PubMed search record** in research results. | Bounded original abstracts through fixed ESearch/EFetch endpoints; existing source IDs and Jev exact-text preview are preserved. No PMC full-text harvesting, bulk corpus collection, entity NER or automatic Jev inference. |

The first two tools are declared automatically for explicitly shared Codex study turns when the desktop backend starts normally. The PubMed adaptation is the same function used by native Codex and DeepAgents research; no additional process or API key is necessary. Requests are paced within each research worker and retry 429/503 once; this is not an application-wide or organization-wide rate limiter.

For literature, combine MeSH concepts with title/abstract variants when recent, unindexed papers matter. Date and publication-type filters are supported through standard PubMed query syntax. A publication type is supplied metadata, not an inferred quality grade. See the [NLM PubMed user guide](https://pubmed.ncbi.nlm.nih.gov/help/) for field tags and indexing/filter limitations (checked 2026-09-23).

Validation: literal source-offset/measurement/negation tests and patient-field exclusion tests passed. A live, public-only query for lung-nodule articles in 2024–2026 returned two original abstracts with journal/date metadata and a reproducible NCBI query receipt. The real subscription image run also called `series_get_metadata`. Hosted report-draft generation and clinical report quality were not validated by those checks.
