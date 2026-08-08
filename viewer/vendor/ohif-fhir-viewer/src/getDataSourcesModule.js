import { createFhirApi } from './FhirDataSource';

function getDataSourcesModule() {
  return [
    {
      name: 'fhir',
      type: 'webApi',
      createDataSource: createFhirApi,
    },
  ];
}

export default getDataSourcesModule;
