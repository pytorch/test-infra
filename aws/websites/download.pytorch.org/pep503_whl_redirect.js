function handler(event) {
    var request = event.request;
    var uri = request.uri;
    var uri_parts = uri.split('/')
    var last_uri_part = uri_parts[uri_parts.length -1]
    var rocm_pattern = /^rocm[0-9]+(\.[0-9]+)*$/

    if (uri.startsWith('/whl')) {
        // Check whether the URI is missing a file name.
        if (uri.endsWith('/')) {
            request.uri += 'index.html';
        // Check whether the URI is folder like
        // I.e. does not have dots in path or rocm\d.\d or rocm\d.\d.\d or 1.8 (for lts)
        // For example /whl/cpu/torch
        } else if (last_uri_part.indexOf('.') == -1
                || last_uri_part.match(rocm_pattern)
                || uri == "/whl/lts/1.8") {
            request.uri += '/index.html';
        }
    }

    // Similar behavior for libtorch
    if (uri.startsWith('/libtorch')) {
        // Check whether the URI is missing a file name.
        if (uri.endsWith('/')) {
            request.uri += 'index.html';
        // Check whether the URI is folder like
        // I.e. does not have dots in path
        // For example /libtorch/cpu
        } else if (last_uri_part.indexOf('.') == -1) {
            request.uri += '/index.html';
        }
    }

    return request;
}
