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
GEMINI_TEXT_MODEL = "gemini-3.1-pro-preview"
GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview" 
GEMINI_VISION_MODEL = "gemini-3.1-flash-image-preview" # Used for image analysis

def generate_gemini_content(api_key, model_name, contents, generation_config=None):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key
    }
    data = {"contents": contents}
    if generation_config:
        data["generationConfig"] = generation_config
        
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
        action = body.get('action', 'full') # full, text_only, image_and_save, analyze_food
        preference = body.get('preference', 'No Preference')
        
        # Ingredients are only required for recipe actions
        if action in ['full', 'text_only', 'image_and_save'] and not ingredients:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'Please provide ingredients'})
            }
        
        if preference == 'Veg':
            non_veg_keywords = ['chicken', 'beef', 'pork', 'fish', 'prawn', 'shrimp', 'meat', 'egg', 'lamb', 'mutton', 'crab', 'lobster', 'salmon', 'tuna', 'bacon', 'sausage', 'turkey', 'duck', 'seafood']
            ings_lower = str(ingredients).lower()
            found = [kw for kw in non_veg_keywords if kw in ings_lower]
            if found:
                return {
                    'statusCode': 400,
                    'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': f"You selected Veg preference, but provided non-veg ingredients."})
                }

        diet_instruction = f"This must strictly be a {preference} recipe. " if preference and preference != 'No Preference' else ""

        ings_str = ingredients if isinstance(ingredients, str) else ', '.join(ingredients)

        if action == 'text_only' or action == 'recipe_by_name_text':
            # Generate Recipe Text ONLY
            if action == 'recipe_by_name_text':
                recipe_name_input = body.get('recipe_name', '')
                if not recipe_name_input:
                    return {
                        'statusCode': 400,
                        'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                        'body': json.dumps({'error': 'Please provide a recipe name'})
                    }
                recipe_prompt = f"Create a healthy {cuisine} recipe for '{recipe_name_input}'. {diet_instruction}Include Title, Ingredients, and a full numbered list of concise (1-2 lines each) step-by-step instructions. Wrap Title in '~' (e.g., ~Title~)."
            else:
                recipe_prompt = f"Create a healthy {cuisine} recipe using: {ings_str}. {diet_instruction}Include Title, Ingredients, and a full numbered list of concise (1-2 lines each) step-by-step instructions. Wrap Title in '~' (e.g., ~Title~)."
            
            contents = [{"parts": [{"text": recipe_prompt}]}]
            text_config = {"maxOutputTokens": 4096, "temperature": 0.5}
            _, recipe_text = generate_gemini_content(api_key, GEMINI_TEXT_MODEL, contents, text_config)
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'recipe': recipe_text})
            }

        elif action == 'image_and_save':
            # Generate Image and Save ONLY
            recipe_text = body.get('recipe_text', '')
            title = body.get('recipe_name', cuisine + " Dish")
            
            image_prompt = f"A photo of {title} on a plate, top view, high quality, 512x512."
            contents = [{"parts": [{"text": image_prompt}]}]
            image_config = {"temperature": 0.4, "topK": 1}
            mime_type, image_b64 = generate_gemini_content(api_key, GEMINI_IMAGE_MODEL, contents, image_config)
            image_data = base64.b64decode(image_b64)

            bucket_name = os.environ.get('BUCKET_NAME')
            table_name = os.environ.get('TABLE_NAME')
            
            image_url = ""
            recipe_id = str(uuid.uuid4())
            timestamp = datetime.datetime.utcnow().isoformat()
            
            if bucket_name:
                file_key = f"{S3_IMAGE_PREFIX}{recipe_id}.jpg"
                s3_client.put_object(Bucket=bucket_name, Key=file_key, Body=image_data, ContentType='image/jpeg', ACL='public-read')
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

        elif action == 'full' or action == 'recipe_by_name':
            # Generate Recipe Text
            if action == 'recipe_by_name':
                recipe_name_input = body.get('recipe_name', '')
                if not recipe_name_input:
                    return {
                        'statusCode': 400,
                        'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                        'body': json.dumps({'error': 'Please provide a recipe name'})
                    }
                recipe_prompt = f"Create a healthy {cuisine} recipe for '{recipe_name_input}'. {diet_instruction}Include Title, Ingredients, and a full numbered list of concise (1-2 lines each) step-by-step instructions. Wrap Title in '~' (e.g., ~Title~)."
            else:
                recipe_prompt = f"Create a healthy {cuisine} recipe using: {ings_str}. {diet_instruction}Include Title, Ingredients, and a full numbered list of concise (1-2 lines each) step-by-step instructions. Wrap Title in '~' (e.g., ~Title~)."
            
            contents = [{"parts": [{"text": recipe_prompt}]}]
            text_config = {"maxOutputTokens": 4096, "temperature": 0.5}
            _, recipe_text = generate_gemini_content(api_key, GEMINI_TEXT_MODEL, contents, text_config)

            # Generate Image and Save
            title = body.get('recipe_name', cuisine + " Dish")
            image_prompt = f"A photo of {title} on a plate, top view, 512x512."
            contents = [{"parts": [{"text": image_prompt}]}]
            image_config = {"temperature": 0.4, "topK": 1}
            mime_type, image_b64 = generate_gemini_content(api_key, GEMINI_IMAGE_MODEL, contents, image_config)
            image_data = base64.b64decode(image_b64)

            bucket_name = os.environ.get('BUCKET_NAME')
            table_name = os.environ.get('TABLE_NAME')
            
            image_url = ""
            recipe_id = str(uuid.uuid4())
            timestamp = datetime.datetime.utcnow().isoformat()
            
            if bucket_name:
                file_key = f"{S3_IMAGE_PREFIX}{recipe_id}.jpg"
                s3_client.put_object(Bucket=bucket_name, Key=file_key, Body=image_data, ContentType='image/jpeg', ACL='public-read')
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
                        'ingredients': ingredients if action != 'recipe_by_name' else f"Search: {recipe_name_input}",
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

        elif action == 'analyze_food':
            # Food Image Analysis (Vision)
            image_b64 = body.get('image_data', '')
            if not image_b64:
                raise Exception("Missing image_data for analyze_food action")
            
            # Remove header if present (e.g. data:image/jpeg;base64,...)
            if "," in image_b64:
                image_b64 = image_b64.split(",")[1]

            prompt = """Analyze this food image and provide nutritional information. 
If the image does not contain any food or is not related to food, simply respond with: "This is not a food image."

If it is food, format your response exactly like this:
**Food Name:** [name of the food]
**Calories:** [number] calories
**Carbohydrates:** [number] grams
**Protein:** [number] grams
**Fat:** [number] grams

Provide a brief description of the dish below that."""
            
            contents = [{
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": "image/jpeg",
                            "data": image_b64
                        }
                    },
                    {"text": prompt}
                ]
            }]
            
            _, analysis_text = generate_gemini_content(api_key, GEMINI_VISION_MODEL, contents)
            
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'caption': analysis_text})
            }
            
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode('utf-8')
        print(f"Gemini API HTTP Error: {e.code} - {error_msg}")
        try:
            error_json = json.loads(error_msg)
            if 'error' in error_json:
                error_msg = error_json['error'].get('message', error_msg)
        except:
            pass
        return {
            'statusCode': e.code,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Gemini API Error: {error_msg}"})
        }
    except Exception as e:
        print(f"Lambda Exception: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }
