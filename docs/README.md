# Thailand e-GP Procurement Technical Documentation

This directory contains in-depth architectural and operational guides for all systems in the Thailand electronic Government Procurement (e-GP) extraction pipeline.

---

## Documentation Index

| Document | Focus Area | Key Topics Covered |
| :--- | :--- | :--- |
| **[DATA_FLOW_ARCHITECTURE.md](./DATA_FLOW_ARCHITECTURE.md)** | **End-to-End System Architecture** | • Distributed multi-host architecture diagram<br/>• Sequence flow between discovery, resolution, and extraction<br/>• Operating hours comparison matrix & recommended cron schedules |
| **[DATA_GO_TH.md](./DATA_GO_TH.md)** | **Open Government Data (`data.go.th`)** | • CKAN REST API endpoints (`datastore_search`, `package_show`)<br/>• Fiscal Year 2568 resource partitions (Part 1 through Part 10)<br/>• 24/7 cloud availability & batch sync schedule |
| **[PROCESS3_GPROCUREMENT.md](./PROCESS3_GPROCUREMENT.md)** | **e-GP Daily RSS Feed (`process3`)** | • Comprehensive announcement taxonomy (`B0`, `D0`, `D1`, `15`, `P0`, `W0`, etc.)<br/>• Windows-874 / TIS-620 character decoding protocol<br/>• Peak hours congestion (09:00–11:30 ICT) & weekend zero-item behavior |
| **[PROCESS5_GPROCUREMENT.md](./PROCESS5_GPROCUREMENT.md)** | **e-GP Document Vault (`process5`)** | • REST microservices (`approval-service`, `price-estimate`, `upload-service`)<br/>• Internal `.zip` archive structure (`Attach_TOR_1.pdf`)<br/>• **Daily 00:00–04:00 batch maintenance window** & optimal cron windows |

