// CloudFront Function (viewer request) for the DEFAULT behavior of the portfolio distribution.
// Makes /restaurantgrader and /restaurantgrader/ open the app's index.html (S3 doesn't do this on its own).
// If your distribution already has a viewer-request function, merge these lines into it.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/restaurantgrader') {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/restaurantgrader/' } } };
  }
  if (uri === '/restaurantgrader/') {
    request.uri = '/restaurantgrader/index.html';
  }
  return request;
}
