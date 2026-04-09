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
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key
    }
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
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key or api_key == "REPLACE_WITH_YOUR_KEY":
            raise Exception("GEMINI_API_KEY environment variable is missing or invalid")

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

        action = body.get('action', 'full') # full, text_only, image_and_save

        if action == 'text_only':
            # Generate Recipe Text ONLY
            recipe_prompt = f"Create a {cuisine} recipe using: {', '.join(ingredients)}. Include a Title, Ingredients list, and Step-by-step instructions. Quote Recipe name with in \"~\"."
            _, recipe_text = generate_gemini_content(api_key, 'gemini-3.1-pro-preview', recipe_prompt)
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'recipe': recipe_text})
            }

        elif action == 'image_and_save':
            # Generate Image and Save ONLY
            recipe_text = body.get('recipe_text', '')
            title = body.get('recipe_name', cuisine + " Dish")
            
            image_prompt = f"Create a picture of {title} served in a plate"
            mime_type, image_b64 = generate_gemini_content(api_key, 'gemini-3.1-flash-image-preview', image_prompt)
            image_data = base64.b64decode(image_b64)

            bucket_name = os.environ.get('BUCKET_NAME')
            table_name = os.environ.get('TABLE_NAME')
            
            image_url = ""
            recipe_id = str(uuid.uuid4())
            timestamp = datetime.datetime.utcnow().isoformat()
            
            if bucket_name:
                file_key = f"{S3_IMAGE_PREFIX}{recipe_id}.png"
                s3_client.put_object(Bucket=bucket_name, Key=file_key, Body=image_data, ContentType='image/png', ACL='public-read')
                region = os.environ.get('AWS_REGION', 'us-east-1')
                image_url = f"https://{bucket_name}.s3.amazonaws.com/{file_key}" if region == 'us-east-1' else f"https://{bucket_name}.s3.{region}.amazonaws.com/{file_key}"
                    
            if table_name:
                table = dynamodb.Table(table_name)
                table.put_item(
                    Item={
                        'id': recipe_id,
                        'type': 'recipe-ai',
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
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'id': recipe_id, 'image_base64': image_b64, 'image_url': image_url})
            }

        elif action == 'full':
            # Generate Recipe Text
            recipe_prompt = f"Create a {cuisine} recipe using: {', '.join(ingredients)}. Include a Title, Ingredients list, and Step-by-step instructions. Quote Recipe name with in \"~\"."
            _, recipe_text = generate_gemini_content(api_key, 'gemini-3.1-pro-preview', recipe_prompt)

            # Generate Image and Save
            title = body.get('recipe_name', cuisine + " Dish")
            image_prompt = f"Create a picture of {title} in a fancy restaurant with a Gemini theme"
            mime_type, image_b64 = generate_gemini_content(api_key, 'gemini-3.1-flash-image-preview', image_prompt)
            image_data = base64.b64decode(image_b64)

            bucket_name = os.environ.get('BUCKET_NAME')
            table_name = os.environ.get('TABLE_NAME')
            
            image_url = ""
            recipe_id = str(uuid.uuid4())
            timestamp = datetime.datetime.utcnow().isoformat()
            
            if bucket_name:
                file_key = f"{S3_IMAGE_PREFIX}{recipe_id}.png"
                s3_client.put_object(Bucket=bucket_name, Key=file_key, Body=image_data, ContentType='image/png', ACL='public-read')
                region = os.environ.get('AWS_REGION', 'us-east-1')
                image_url = f"https://{bucket_name}.s3.amazonaws.com/{file_key}" if region == 'us-east-1' else f"https://{bucket_name}.s3.{region}.amazonaws.com/{file_key}"
                    
            if table_name:
                table = dynamodb.Table(table_name)
                table.put_item(
                    Item={
                        'id': recipe_id,
                        'type': 'recipe-ai',
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
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'id': recipe_id, 'recipe': recipe_text, 'image_base64': image_b64, 'image_url': image_url})
            }
            
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8')
        print(f"HTTPError: {e.code} - {error_msg}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': f"HTTP Error {e.code}: {e.reason} - {error_msg}"})
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
