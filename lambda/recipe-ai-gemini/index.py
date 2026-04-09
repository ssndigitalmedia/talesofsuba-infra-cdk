import json
import os
import base64
import boto3
import uuid
import datetime
import urllib.request

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

S3_IMAGE_PREFIX = "pocketapps/recipe-ai/generated-images/"


def generate_gemini_content(api_key, model_name, prompt):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}
    data = {
        "contents": [{
            "parts": [{"text": prompt}]
        }]
    }
    req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers=headers)
    
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode("utf-8"))
        # GenerativeLanguage API returns candidates[0].content.parts[0]
        parts = result.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0]
        
        if 'inlineData' in parts:
            # It's an image base64
            mime_type = parts['inlineData'].get('mimeType', 'image/png')
            b64_data = parts['inlineData'].get('data', '')
            return mime_type, b64_data
        else:
            # It's text
            return 'text/plain', parts.get('text', '')

def handler(event, context):
    try:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise Exception("GEMINI_API_KEY environment variable is missing")

        # Parse Input depending on APIGW format
        if 'body' in event and isinstance(event['body'], str):
            body = json.loads(event.get('body', '{}'))
        else:
            body = event if isinstance(event, dict) else {}
            
        ingredients = body.get('ingredients', [])
        cuisine = body.get('cuisine', 'General')
        
        if not ingredients:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Please provide ingredients'})
            }

        # Generate Recipe Text using REST API
        recipe_prompt = f"Create a {cuisine} recipe using: {', '.join(ingredients)}. Include a Title, Ingredients list, and Step-by-step instructions. Quote Recipe name with in \"~\"."
        _, recipe_text = generate_gemini_content(api_key, 'gemini-1.5-flash', recipe_prompt)

        # Extract title or default to generic cuisine
        title = body.get('recipe_name')
        if not title:
            title = cuisine + " Dish"
            for line in recipe_text.splitlines():
                if line.strip():
                    title = line[:200]
                    break
                
        # The user requested passing the recipe name as input to the image preview moded
        # "input is reciper name image. i will passs from the input"
        image_prompt = f"Create a picture of {title} in a fancy restaurant with a Gemini theme"
        
        # Generate Image using new gemini-3.1-flash-image-preview
        mime_type, image_b64 = generate_gemini_content(api_key, 'gemini-3.1-flash-image-preview', image_prompt)
        image_data = base64.b64decode(image_b64)

        bucket_name = os.environ.get('BUCKET_NAME')
        table_name = os.environ.get('TABLE_NAME')
        
        image_url = ""
        recipe_id = str(uuid.uuid4())
        timestamp = datetime.datetime.utcnow().isoformat()
        
        if bucket_name:
            file_key = f"{S3_IMAGE_PREFIX}{recipe_id}.png"
            s3_client.put_object(
                Bucket=bucket_name,
                Key=file_key,
                Body=image_data,
                ContentType='image/png',
                ACL='public-read'
            )
            region = os.environ.get('AWS_REGION', 'us-east-1')
            if region == 'us-east-1':
                image_url = f"https://{bucket_name}.s3.amazonaws.com/{file_key}"
            else:
                image_url = f"https://{bucket_name}.s3.{region}.amazonaws.com/{file_key}"
                
        if table_name:
            table = dynamodb.Table(table_name)
            table.put_item(
                Item={
                    'id': recipe_id,
                    'type': 'recipe-ai', # GSI partition key matching existing patterns
                    'email': body.get('email', 'anonymous'),
                    'cuisine': cuisine,
                    'ingredients': ingredients,
                    'recipeText': recipe_text,
                    'image': image_url,
                    'date': timestamp,
                    'title': title
                }
            )

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            'body': json.dumps({
                'id': recipe_id,
                'recipe': recipe_text,
                'image_base64': image_b64,
                'image_url': image_url,
                'image_type': 'image/png'
            })
        }

    except Exception as e:
        print(f"Error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': str(e)})
        }
