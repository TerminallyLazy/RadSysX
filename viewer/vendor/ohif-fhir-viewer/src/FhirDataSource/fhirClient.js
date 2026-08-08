export function subscribeToQueryLog(listener) {
  listener([]);
  return () => {};
}

export function getQueryLog() {
  return [];
}

export function clearQueryLog() {}

export function addLogEntry() {}

export async function fhirFetch(baseUrl, path, { authToken, accept, responseType } = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const headers = {};
  if (accept) {
    headers['Accept'] = accept;
  } else {
    headers['Accept'] = 'application/fhir+json';
  }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`FHIR request failed with status ${response.status}`);
    }

    if (responseType === 'arraybuffer') {
      return response.arrayBuffer();
    }
    return response.json();
  } catch (error) {
    throw error;
  }
}

export function fetchPatient(baseUrl, patientId, opts = {}) {
  return fhirFetch(baseUrl, `/Patient/${encodeURIComponent(patientId)}`, opts);
}

export function fetchImagingStudies(baseUrl, patientId, opts = {}) {
  return fhirFetch(baseUrl, `/ImagingStudy?patient=${encodeURIComponent(patientId)}`, opts);
}

export function fetchImagingStudyById(baseUrl, imagingStudyId, opts = {}) {
  return fhirFetch(baseUrl, `/ImagingStudy/${encodeURIComponent(imagingStudyId)}`, opts);
}

export function fetchDocumentReferences(baseUrl, { patientId, imagingStudyId } = {}, opts = {}) {
  let path = `/DocumentReference?patient=${encodeURIComponent(patientId)}&type=http://loinc.org|18748-4`;
  if (imagingStudyId) {
    path += `&related=ImagingStudy/${encodeURIComponent(imagingStudyId)}`;
  }
  return fhirFetch(baseUrl, path, opts);
}

export function fetchDicomFile(serverRoot, fileUrl, opts = {}) {
  const url = fileUrl.startsWith('http') ? fileUrl : `${serverRoot}${fileUrl}`;

  const headers = {};
  if (opts.authToken) {
    headers['Authorization'] = `Bearer ${opts.authToken}`;
  }

  return fetch(url, { headers })
    .then(response => {
      if (!response.ok) {
        throw new Error(`DICOM fetch failed: ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .catch(error => {
      throw error;
    });
}
