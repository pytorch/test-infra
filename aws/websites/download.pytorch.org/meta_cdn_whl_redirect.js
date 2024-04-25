function handler(event) {
    // NOTE: This example function is for a viewer request event trigger.
    // Choose viewer request for event trigger when you associate this function with a distribution.
    var request = event.request;
    var uri = request.uri;
    var CDN_TEST_PATH = '/whl/cdntest/';

    // if we are requesting for whl files in cdntest path - perform the translation to meta CDN
    if(uri.startsWith(CDN_TEST_PATH) && uri.endsWith('.whl')) {
        var uri_suffix = uri.slice(CDN_TEST_PATH.length).split('/').join('%2F');
        var meta_cdn_path = 'https://scontent.xx.fbcdn.net/mci_ab/uap/?ab_b=m&amp;ab_page=PyTorchBinary&amp;ab_entry=tree%2Fwhl%2Ftest%2F'
        request.uri=meta_cdn_path+uri_suffix
    }

    return request;
}
