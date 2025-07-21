# Event Tracking guidance

# Overview

Guidance for event tracking in torchci.

## Google Analytics Development Guide (Local Development)

### Overview

This guide explains how to enable Google Analytics 4 (GA4) debug mode during local development so you can verify event tracking in real time via GA DebugView.

### Prerequisites

- TorchCI front-end development environment is set up and running locally
- Chrome browser installed
- Install chrome extension [Google Analytics Debugger](https://chrome.google.com/webstore/detail/jnkmfdileelhofjcijamephohjechhna)
- Make sure you have permission to the GCP project `pytorch-hud` as admin. If not, reach out to `oss support (internal only)` or @pytorch/pytorch-dev-infra to add you

## Steps

### 1. Append `?debug_mode=true` to Your Local URL

Go to the page you want to testing the tracking event, and add parameter `?debug_mode=true`
Example:

```
http://localhost:3000/queue_time_analysis?debug_mode=true
```

you should see the QA debugging info in console：

### View debug view in Google Analytics

[Analytics DebugView](https://analytics.google.com/analytics/web/#/a44373548p420079840/admin/debugview/overview)

When click a tracking button or event, you should be able to see it logged in the debugview (it may have 2-15 secs delayed).

### Adding event to track

two options to add event:

#### data attribute

Provided customized listener to catch tracking event using data-attributes

This is used to track simple user behaviours.

```tsx
 Example usage:
    <button
     data-ga-action="signup_click"
     data-ga-label="nav_button"
     data-ga-category="cta"
     data-ga-event-types="click"
   >
      Sign Up
   </button>
```

Supported data attributes:

- `data-ga-action` (required): GA action name
- `data-ga-category` (optional): GA category (defaults to event type)
- `data-ga-label` (optional): GA label
- `data-ga-event-types` (optional): comma-separated list of allowed event types for this element (e.g. "click,submit")

````
#### using trackEventWithContext
using trackEventWithContext to provide extra content.

```tsx
trackEventWithContext(
action: string,
category?: string,
label?: string,
extra?: Record<string, any>
)
````
