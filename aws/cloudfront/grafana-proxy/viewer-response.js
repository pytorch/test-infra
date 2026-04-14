// CloudFront Function (viewer-response) for distribution E2Z345QRXN6Y77
// Strips frame-ancestors from CSP and x-frame-options to allow iframe embedding
// on hud.pytorch.org.
//
// Deploy: CloudFront Console > Functions > Create > paste this code >
// Associate with distribution E2Z345QRXN6Y77 (disz2yd9jqnwc.cloudfront.net),
// event type: viewer-response, cache behavior: Default (*).
function handler(event) {
  var response = event.response;
  var headers = response.headers;

  // Remove x-frame-options (legacy frame-blocking header)
  delete headers["x-frame-options"];

  // Rewrite CSP: replace frame-ancestors 'none' with hud.pytorch.org
  if (headers["content-security-policy"]) {
    headers["content-security-policy"].value =
      headers["content-security-policy"].value.replace(
        /frame-ancestors\s+'none'/,
        "frame-ancestors 'self' https://hud.pytorch.org"
      );
  }

  return response;
}
