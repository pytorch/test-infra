const QueueDataExplanation = () => (
  <div style={{ fontSize: "0.9rem", color: "#666", lineHeight: 1.5 }}>
    <strong>How We Collect Queue Data:</strong>
    <br />
    Every 30 minutes, we capture a snapshot of all jobs that were in the queue
    during that window. This includes:
    <br />- Jobs that <em>were queued and completed</em> before the snapshot.
    <br />- Jobs that <em>are still in the queue</em> at the time of collection.
    <br />
    <br />
    This provides a more complete view of queue activity and wait times.
  </div>
);

export default QueueDataExplanation;
