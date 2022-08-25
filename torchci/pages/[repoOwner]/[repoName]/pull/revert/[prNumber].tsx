import Head from "next/head";
import { useRouter } from "next/router";
import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { revertClassifications } from "lib/bot/Constants";
import ReactMarkdown from "react-markdown";
import { Col, Container, Row } from "react-bootstrap";

const getMessage = (
  message: string,
  classification: string,
  suffix: string
) => {
  return `@pytorchbot revert -m '${message}' -c '${classification}'
  
  ${suffix}
  # blah
  `;
};

export default function Revert() {
  const router = useRouter();
  const commit = router.query.commit;
  const { repoOwner, repoName, prNumber } = router.query;
  const [disableButton, setDisableButton] = useState(false);
  const [message, setMessage] = useState("");
  const [classification, setClassification] = useState("");
  const msg = getMessage(message, classification, "");
  return (
    <>
      <Head>
        <title>
          Revert PR #{prNumber} in {repoOwner}/{repoName}
        </title>
      </Head>
      <Container>
        <Row>
          <Col>
            <h1>
              Revert PR #{prNumber} in {repoOwner}/{repoName}
            </h1>
            <Form>
              <Form.Group className="mb-3">
                <Form.Label>Revert Message</Form.Label>
                <Form.Control
                  as="textarea"
                  rows={3}
                  onChange={(e) => {
                    e.preventDefault();
                    setMessage(e.target.value);
                  }}
                />
              </Form.Group>

              <Form.Label>Revert Classification</Form.Label>
              <Form.Select
                aria-label="What type of breakage is this"
                onChange={(e) => {
                  e.preventDefault();
                  setClassification(e.target.value);
                }}
              >
                {Object.entries(revertClassifications).map(
                  ([classification, name]) => (
                    <option key={name} value={classification}>
                      {name}
                    </option>
                  )
                )}
              </Form.Select>
              <Button variant="primary" type="submit">
                Revert!
              </Button>
            </Form>
          </Col>
          <Col>
            <h1>Message Preview</h1>
            <div
              style={{
                border: "1px solid",
                borderRadius: "16px",
                padding: "5px",
                height: "100%",
              }}
            >
              <ReactMarkdown>{msg}</ReactMarkdown>
            </div>
          </Col>
        </Row>
      </Container>
    </>
  );
}
