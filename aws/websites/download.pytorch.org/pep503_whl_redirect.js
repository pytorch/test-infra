function handler(event) {
    var request = event.request;
    var uri = request.uri;
    
    if (uri.startsWith('/whl')) {
        // Check whether the URI is missing a file name.
        if (uri.endsWith('/')) {
            request.uri += 'index.html';
        // Check whether the URI is folder like
        // I.e. does not have dots in path
        // For example /whl/cpu/torch
        } else if (uri.indexOf('.') == -1) {
            request.uri += '/index.html';
        }
    } 

    return request;
}