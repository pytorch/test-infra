# V2 HUD

Used for HUD V2 UI. This approach offers several benefits, including improved performance, scalability, and developer experience. For more details on the advantages of the Next.js app approach, please refer to the [Next.js documentation](https://nextjs.org/docs/app).

# Migration Plan

We plan migrate exisiting page-based routes to the new V2 structure using Next.js app structure in H2 2025.

## July

- Setup: Establish the V2 app structure, including the navbar, GitHub signup functionality.
- Guidance: Provide comprehensive guidance to developers on the new structure, including tests, structure, and etc
- Implementation: Post-July, all new features should be implemented in the V2 structure.

## August - September

- Transition the majority of routes from the pages/ directory to the new V2 HUD structure.
- Applies Dark/Light mode to the v2 structure

## October

- Deprecation: Officially deprecate the legacy HUD (v1) system.

# Affected Areas

## Affected Folders

- app/v2/: This folder will house the new app structure.
- pages/: This folder contains all file-based navigation elements.
- dark/light settings

## Affected Users

- Developers within the Dev Infra Team.

# Changes Tracking

- `2025-07-02`: Initial setup of the V2 app structure.
