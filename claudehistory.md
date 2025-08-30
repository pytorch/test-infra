> Read through claude.MD. Let's start by talking this through. Come up with some questions to ask on the project / repo.

⏺ I'll read through the CLAUDE.md file to understand the project and come up with relevant questions.

⏺ Read(CLAUDE.md)
  ⎿  Read 52 lines (ctrl+r to expand)

⏺ Ahoy matey! After reading through the CLAUDE.md, I can see ye be charting a course for some serious GPU infrastructure. This developer server project has some meaty technical challenges ahead! Let me anchor
  down with some key questions to help navigate these waters:

  Architecture & Scale Questions:
  1. What's the target number of concurrent developers you expect to support? This affects queue sizing and server provisioning.
  2. Should we start with a single AWS region (us-east-1) or plan multi-region from the start?
  3. For the "2x8 GPU" multi-server setup - are we talking about EFA (Elastic Fabric Adapter) networking between instances?

  Technical Implementation:
  4. For the CLI tool - any preference between Python (easier integration) vs Rust (performance)?
  5. What's your preferred queue technology - SQS, EventBridge, or something else?
  6. For K8s - EKS with GPU node groups, or were you thinking something different?

  Auth & Security:
  7. The "metamates group" - is this a specific GitHub organization/team I should verify against?
  8. Should reservation time limits be configurable per user or have fixed tiers?

  Infrastructure Questions:
  9. Budget constraints for the H100 instances? Those beauties don't come cheap!
  10. Any compliance requirements (SOC2, etc.) that might affect the architecture?

  Which of these areas would ye like to dive into first, or shall we start mapping out the overall architecture diagram?
