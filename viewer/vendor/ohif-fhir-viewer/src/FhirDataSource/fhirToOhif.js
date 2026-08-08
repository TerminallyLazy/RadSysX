export function imagingStudyToStudySummary(imagingStudy, patientName) {
  const studyInstanceUid = extractStudyInstanceUID(imagingStudy);
  const modalities = extractModalities(imagingStudy);
  const numInstances = countInstances(imagingStudy);

  return {
    studyInstanceUid,
    date: imagingStudy.started ? imagingStudy.started.substring(0, 10).replace(/-/g, '') : '',
    time: imagingStudy.started ? imagingStudy.started.substring(11, 19).replace(/:/g, '') : '',
    patientName: patientName || '',
    description: imagingStudy.description || '',
    modalities: modalities.join('\\'),
    instances: numInstances,
    mrn: extractPatientId(imagingStudy),
    accession: extractAccession(imagingStudy),
    NumInstances: numInstances,
    StudyInstanceUID: studyInstanceUid,
    PatientName: patientName || '',
    StudyDate: imagingStudy.started ? imagingStudy.started.substring(0, 10).replace(/-/g, '') : '',
    StudyTime: imagingStudy.started
      ? imagingStudy.started.substring(11, 19).replace(/:/g, '')
      : '',
    StudyDescription: imagingStudy.description || '',
    AccessionNumber: extractAccession(imagingStudy),
    PatientID: extractPatientId(imagingStudy),
    Modalities: modalities.join('\\'),
    _fhirResourceId: imagingStudy.id,
  };
}

function extractStudyInstanceUID(imagingStudy) {
  if (!imagingStudy.identifier) return '';
  const dicomUid = imagingStudy.identifier.find(
    id => id.system === 'urn:dicom:uid' || (id.value && id.value.startsWith('urn:oid:'))
  );
  if (dicomUid) {
    return dicomUid.value.replace('urn:oid:', '');
  }
  return imagingStudy.id || '';
}

function extractModalities(imagingStudy) {
  if (imagingStudy.modality && Array.isArray(imagingStudy.modality)) {
    return imagingStudy.modality.map(m => m.code || m.display || '');
  }
  if (imagingStudy.series) {
    const mods = new Set();
    imagingStudy.series.forEach(s => {
      if (s.modality) {
        mods.add(s.modality.code || s.modality.display || '');
      }
    });
    return Array.from(mods);
  }
  return [];
}

function countInstances(imagingStudy) {
  if (imagingStudy.numberOfInstances) return imagingStudy.numberOfInstances;
  if (imagingStudy.series) {
    return imagingStudy.series.reduce((sum, s) => sum + (s.numberOfInstances || 0), 0);
  }
  return 0;
}

function extractPatientId(imagingStudy) {
  if (imagingStudy.subject && imagingStudy.subject.reference) {
    return imagingStudy.subject.reference.replace('Patient/', '');
  }
  return '';
}

function extractAccession(imagingStudy) {
  if (!imagingStudy.identifier) return '';
  const accession = imagingStudy.identifier.find(
    id =>
      id.type &&
      id.type.coding &&
      id.type.coding.some(c => c.code === 'ACSN')
  );
  return accession ? accession.value : '';
}

/**
 * Extract series and instance metadata from a FHIR ImagingStudy resource.
 * Returns OHIF-compatible structures for DicomMetadataStore.
 */
export function extractSeriesMetadata(imagingStudy, StudyInstanceUID) {
  const seriesList = [];
  const instancesBySeriesUID = new Map();

  if (!imagingStudy.series || !Array.isArray(imagingStudy.series)) {
    return { seriesList, instancesBySeriesUID };
  }

  for (const series of imagingStudy.series) {
    const SeriesInstanceUID = series.uid || '';
    if (!SeriesInstanceUID) continue;

    const Modality = series.modality ? (series.modality.code || series.modality.display || '') : '';
    const SeriesDescription = series.description || '';
    const SeriesNumber = series.number != null ? series.number : '';

    seriesList.push({
      StudyInstanceUID,
      SeriesInstanceUID,
      Modality,
      SeriesDescription,
      SeriesNumber,
    });

    const instances = [];
    if (series.instance && Array.isArray(series.instance)) {
      for (const inst of series.instance) {
        const SOPInstanceUID = inst.uid || '';
        if (!SOPInstanceUID) continue;

        // Strip urn:oid: prefix from sopClass if present
        let SOPClassUID = '';
        if (inst.sopClass) {
          SOPClassUID = (inst.sopClass.code || inst.sopClass.system || '')
            .replace('urn:oid:', '');
        }

        // Extract GridFS file ID from instance extensions (for servers using MongoDB GridFS)
        let gridfsFileId = '';
        if (inst.extension) {
          const gridfsExt = inst.extension.find(e => e.url === 'gridfsFileId');
          if (gridfsExt) {
            gridfsFileId = gridfsExt.valueString || '';
          }
        }

        instances.push({
          StudyInstanceUID,
          SeriesInstanceUID,
          SOPInstanceUID,
          SOPClassUID,
          InstanceNumber: inst.number != null ? inst.number : '',
          title: inst.title || '',
          gridfsFileId,
        });
      }
    }

    instancesBySeriesUID.set(SeriesInstanceUID, instances);
  }

  return { seriesList, instancesBySeriesUID };
}
