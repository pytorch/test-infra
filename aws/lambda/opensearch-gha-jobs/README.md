This lambda is used to indexed the content of `torch-workflow-job`
DynamoDB table onto the OpenSearch cluster `gha-job`. This is done by
listening to the stream of `INSERT`, `MODIFY`, and `REMOVE` events
coming to the DynamoDB table, extracting the documents, and indexing
them on the OpenSeach cluster.

Because the JSON structure of a DynamoDB event includes some simple
datatype annotation ([link](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_AttributeValue.html)).
The lambda performs some transformation to convert it back to a regular
JSON data structure.

### Deployment

A new version of the lambda can be deployed using `make deploy` and it
is done so automatically as part of the CI.
