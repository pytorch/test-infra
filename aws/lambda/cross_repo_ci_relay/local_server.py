import json

from dotenv import find_dotenv, load_dotenv
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse


load_dotenv(find_dotenv(usecwd=True))

from callback import lambda_function as callback_lambda
from webhook import lambda_function as webhook_lambda


relay_router = APIRouter()


@relay_router.post("/github/webhook")
async def github_webhook(req: Request):
    body = await req.body()
    event = {
        "requestContext": {
            "http": {
                "method": req.method,
                "path": req.url.path,
            }
        },
        "headers": {k.decode(): v.decode() for k, v in req.scope["headers"]},
        "body": body.decode("utf-8"),
        "isBase64Encoded": False,
    }

    result = webhook_lambda.lambda_handler(event, None)
    return JSONResponse(
        status_code=result["statusCode"], content=json.loads(result["body"])
    )


@relay_router.post("/github/result")
async def github_result(req: Request):
    body = await req.body()
    event = {
        "requestContext": {
            "http": {
                "method": req.method,
                "path": req.url.path,
            }
        },
        "headers": {k.decode(): v.decode() for k, v in req.scope["headers"]},
        "body": body.decode("utf-8"),
        "isBase64Encoded": False,
    }

    result = callback_lambda.lambda_handler(event, None)
    return JSONResponse(
        status_code=result["statusCode"], content=json.loads(result["body"])
    )


# ================= FastAPI apps =================
# - relay_router: defines the same endpoints as the Lambda functions, but callable via HTTP for local testing

relay_server = FastAPI()
relay_server.include_router(relay_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("local_server:relay_server", host="0.0.0.0", port=8000, reload=True)
