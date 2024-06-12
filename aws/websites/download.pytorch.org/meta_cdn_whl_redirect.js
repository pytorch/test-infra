function handler(event) {
    var request = event.request;
    const headers = request.headers;
    var uri = request.uri;
    var uri_parts = uri.split('/');
    var last_uri_part = uri_parts[uri_parts.length -1];
    var rocm_pattern = /^rocm[0-9]+\.[0-9]+$/
    var CDN_TEST_PATH = '/whl/cdntest/';

    // if we are requesting for whl files in cdntest path:
    // - redirect to download.pytorch.org in case of CN
    // - default perform the translation to meta CDN
    if( uri.startsWith(CDN_TEST_PATH) && uri.endsWith('.whl') ) {
        var uri_suffix = uri.slice(CDN_TEST_PATH.length);
        var redirect_value = '';

        if (headers['cloudfront-viewer-country']) {
            const countryCode = Symbol.for(headers['cloudfront-viewer-country'].value);
            if (countryCode === Symbol.for('CA')) {
                redirect_value = 'https://download.pytorch.org/whl/test/'+uri_suffix;
            }
        }
        if(redirect_value == '') {
            var meta_cdn_path = 'https://scontent.xx.fbcdn.net/mci_ab/uap/?ab_b=m&ab_page=PyTorchBinary&ab_entry=tree%2Fwhl%2Ftest%2F'
            redirect_value = meta_cdn_path+uri_suffix.split('/').join('%2F');
        }

        const response = {
                statusCode: 302,
                statusDescription: 'Found',
                headers:
                    { "location": { "value": redirect_value } }
                }

        return response;
    }

    if (uri.startsWith('/whl')) {
        // Check whether the URI is missing a file name.
        if (uri.endsWith('/')) {
            request.uri += 'index.html';
        // Check whether the URI is folder like
        // I.e. does not have dots in path or rocm\d.\d or 1.8 (for lts)
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
