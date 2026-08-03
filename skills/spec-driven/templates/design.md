# Design: <change-name>
*The "how" — architecture, technical decisions, data flow, testing strategy.*

## Architecture Overview
<High-level diagram or description. ASCII art is fine.>

## Technical Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| <Decision 1> | <Why this and not the alternatives> | <What else was on the table> |
| <Decision 2> | <Why> | <Alternatives> |

## Implementation Approach

### Components
1. **<Component 1>**: <Purpose and responsibility>
2. **<Component 2>**: <Purpose and responsibility>

### Data Flow
<Describe how data flows through the system. Diagrams or step-by-step traces both work.>

### Database Changes
```sql
-- New tables, columns, or schema changes
```

### API Changes (if applicable)
- **POST** `/api/<endpoint>` — <purpose>
- **GET** `/api/<endpoint>` — <purpose>

## Dependencies
- <External library, service, or other change this depends on>
- <…>

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| <Risk 1> | <High/Med/Low> | <How to address> |
| <Risk 2> | <High/Med/Low> | <How to address> |

## Testing Strategy
- **Unit tests**: <What to cover>
- **Integration tests**: <What to cover>
- **Manual verification**: <Scenarios to walk through by hand>
