import json
from dotenv import find_dotenv, load_dotenv
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse


load_dotenv(find_dotenv(usecwd=True))

import lambda_function


webhook_router = APIRouter()


@webhook_router.post("/github/webhook")
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

    result = lambda_function.lambda_handler(event, None)
    return JSONResponse(
        status_code=result["statusCode"], content=json.loads(result["body"])
    )


# ================= FastAPI apps =================
# - webhook_app: only /github/webhook (for smee forward)

webhook_app = FastAPI()
webhook_app.include_router(webhook_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("local_server:webhook_app", host="0.0.0.0", port=8000, reload=True)
