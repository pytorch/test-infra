function handler(event) {
    var request = event.request;
    var uri = request.uri;
    
    // Check whether the URI is missing a file name.
    if (uri.startsWith('/whl') && uri.endsWith('/')) {
        request.uri += 'index.html';
    } 

    return request;
}