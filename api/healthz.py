def handler(request):
    return {
        "statusCode": 200,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*"
        },
        "body": '{"ok": true}'
    }
