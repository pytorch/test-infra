import requests

def download_content(url):
    try:
        # Send a GET request to the URL
        response = requests.get(url)
        
        # Check if the request was successful
        response.raise_for_status()
        
        # Get the content
        content = response.text
        
        # Save the content to a file
        with open('downloaded_content.txt', 'w', encoding='utf-8') as file:
            file.write(content)
        
        print("Content downloaded successfully and saved to 'downloaded_content.txt'")
    
    except requests.exceptions.RequestException as e:
        print(f"An error occurred: {e}")

# URL to download
url = "https://ossci-raw-job-status.s3.amazonaws.com/log/28663117786"

# Call the function to download the content
download_content(url)