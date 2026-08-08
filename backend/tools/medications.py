import requests
from langchain.tools import tool

@tool("Retrieve_drug_information_from_RxNorm_API")
def get_rxnorm_info_by_ndc(ndc_code):
    """
    Description: Retrieve drug information from RxNorm API using NDC code.
    - Input: NDC code (str)
    - Output: Drug name (str)
    """
    base_url = 'https://rxnav.nlm.nih.gov/REST'
    ndc_to_rxcui_endpoint = f'/ndcstatus.json?ndc={ndc_code}'
    
    rxcui_response = requests.get(base_url + ndc_to_rxcui_endpoint)
    if rxcui_response.status_code == 200:
        rxcui_data = rxcui_response.json()
        rxcui = rxcui_data.get('ndcStatus', {}).get('rxcui', '')
        if rxcui:
            rxcui_info_endpoint = f'/rxcui/{rxcui}/properties.json'
            info_response = requests.get(base_url + rxcui_info_endpoint)
            if info_response.status_code == 200:
                info_data = info_response.json()
                return info_data.get('properties', {}).get('name', "Name not found")
            else:
                return "Failed to retrieve drug info."
        else:
            return "No RxCUI found for this NDC code."
    else:
        return "Failed to retrieve RxCUI."

#print(get_rxnorm_info_by_ndc("00597-0087-17"))
    
@tool("Retrieve_drug_use_cases_from_OpenFDA_API")
def get_drug_use_cases(drug_name):
    """
    Description: Retrieve drug use cases from OpenFDA API using drug name.
    - Input: Drug name (str)
    - Output: Drug name (str), Use cases (list)
    """
    endpoint = "https://api.fda.gov/drug/label.json"
    params = {
        'search': f'active_ingredient:{drug_name}',
        'limit': 1
    }
    response = requests.get(endpoint, params=params)
    data = response.json()

    result = {'drug_name': drug_name}

    if 'results' in data and data['results']:
        use_cases = data['results'][0].get('indications_and_usage', [])
        result['use_cases'] = use_cases
    else:
        result['use_cases'] = "No results found"

    return result


#use_cases = get_drug_use_cases("aspirin")
#print(use_cases)

@tool("Search_drugs_for_a_given_condition_using_OpenFDA_API")
def search_drugs_for_condition(condition: str) -> str:
    """
    Description: Search drugs for a given condition using OpenFDA API.
    - Input: Condition (str)
    - Output: Drugs indicated for the condition (str)
    """
    api_endpoint = 'https://api.fda.gov/drug/label.json'
    
    search_query = f'search=indications_and_usage:"{condition}"'
    
    url = f'{api_endpoint}?{search_query}&limit=10' 
    response = requests.get(url)
    
    if response.status_code == 200:
        data = response.json()
        
        if 'results' in data and data['results']:
            print(f"Drugs indicated for {condition}:\n")
            for result in data['results']:
                drug_name = result.get('openfda', {}).get('substance_name', ['Unknown'])[0]
                if drug_name != 'Unknown':
                    drug_info = get_drug_use_cases.invoke({"drug_name": drug_name})
                    print(f"- {drug_name}")
                    print(f"  - Use cases: {drug_info['use_cases'][0]}\n")

        else:
            print(f"No drugs found indicated for {condition}.")
    else:
        print(f"Failed to retrieve data. Status code: {response.status_code}")

test_list = "Atelectasis", "Consolidation", "Infiltration", "Pneumothorax", "Edema", "Emphysema", "Fibrosis", "Effusion", "Pneumonia", "Pleural_thickening", "Cardiomegaly", "Nodule Mass Hernia"

#for condition in test_list:
#    search_drugs_for_condition(condition)
#    print("\n")

#print(search_drugs_for_condition("Pneumothorax"))