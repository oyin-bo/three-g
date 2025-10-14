# A Framework for In-Browser WebGL2 Unit Testing

## The Vision: A Testbed in the Native Environment

Testing code that speaks directly to the GPU presents a fundamental challenge: the code's native environment is the browser, a world away from the typical command-line test runner. To bridge this divide, we will not attempt to mock the browser's complex machinery. Instead, we will bring the tests themselves into the browser, creating a remote-controlled laboratory where our WebGL2 kernels and graphics logic can be examined in their natural habitat.

This document outlines the architecture for such a framework, a system built upon our existing remote-execution REPL. It is designed to be resilient, responsive, and deeply integrated into the development workflow.

## The Architecture: A Triumvirate of Roles

The system's design is a separation of concerns, embodied by three principal actors: the Orchestrator, the Supervisor, and the Execution Cell.

### 1. The Orchestrator: The Conductor in the Console

The Node.js server process acts as the central orchestrator, the conductor of our testing symphony. It does not perform the tests itself, but directs the entire ensemble.

- **Discovery and Vigilance:** Upon startup, the Orchestrator scans the project landscape to discover all files designated as tests. It then becomes a vigilant watchtower, observing these files for any sign of change.
- **Initiating the Performance:** When a developer saves a test file, the Orchestrator, after a moment of deliberate pause to ensure the changes are complete, initiates a test run. It composes a message—not of code, but of instructions—and dispatches it to the browser.
- **Receiving the Report:** Its final duty is to receive the results from the browser, formatting them into a clear and concise report delivered directly to the developer's console, providing a real-time narrative of the system's health.

### 2. The Supervisor: The Foreman on the Factory Floor

A dedicated host page within the browser serves as the Supervisor. This is the factory floor where the actual work takes place. Its intelligence is injected by the Orchestrator, transforming it from a simple page into an active manager.

- **Master of the Workers:** The Supervisor's primary role is to manage a fleet of short-lived Web Workers. It does not run any test code on its own thread, ensuring it remains responsive at all times.
- **Enforcing the Deadline:** For each test dispatched to a worker, the Supervisor starts a countdown. If a worker fails to report back in time—the tell-tale sign of an infinite loop or a catastrophic failure—the Supervisor terminates the errant worker without mercy. This resilience ensures that one faulty test cannot halt the entire assembly line.
- **The Canvas Font:** The Supervisor is the keeper of the `OffscreenCanvas`. It creates this resource, a canvas detached from the document, and transfers it to each worker, providing the essential substrate for any WebGL operations.

### 3. The Execution Cell: The Alchemist's Crucible

The Web Worker is the heart of the system, an isolated crucible where the volatile alchemy of a single test can proceed in safety.

- **Sanctuary of Execution:** Each test runs within this sealed environment, preventing it from interfering with the Supervisor or any other test. If a test fails, the crucible contains the failure, which can then be safely discarded.
- **Receiving the Spark:** The worker receives the `OffscreenCanvas` from the Supervisor, from which it can acquire a true WebGL2 context. This is where our kernels are brought to life and their outputs are measured.
- **The Doorman:** Within each worker resides a small, preparatory script—a doorman. This script greets the incoming test file, providing it with the testing primitives it needs to declare its purpose and structure, such as `test()` and `describe()` functions. It provides the vocabulary for the test to express itself.

## The Lines of Communication and Supply

- **The Nervous System:** The existing REPL channel serves as the nervous system connecting the Orchestrator to the Supervisor, allowing commands to flow from the server to the browser and results to return.
- **Taming Dependencies:** To accommodate complex tests involving libraries like `three.js`, the Supervisor page will host an **Import Map**. This acts as a directory assistance for the browser, translating bare import specifiers like `'three'` into concrete file paths. This map is automatically inherited by every module-aware Execution Cell, ensuring that both simple and complex tests can declare their dependencies in a clean and standard way.

## The Workflow in Motion

When a developer saves a file, a cascade is initiated:

1.  The **Orchestrator** detects the change and sends a command to the **Supervisor**.
2.  The **Supervisor** begins to iterate through the discovered test files. For each, it spawns a new **Execution Cell** (a worker).
3.  It transfers an `OffscreenCanvas` to the worker and instructs it which test file to import. A timeout is set.
4.  Inside the worker, the **Doorman** script helps the test file execute. The test, in turn, uses the provided WebGL context to perform its operations.
5.  Upon completion, the worker sends its result back to the Supervisor.
6.  The **Supervisor** collects the result, terminates the worker, and moves to the next test. If a timeout occurs, it records the failure and proceeds.
7.  Once all tests are complete, the Supervisor sends a full report back to the **Orchestrator**, which then presents the final, collated results to the developer.


# Implementation Blueprint: The Living Testbed

This guide puts flesh upon the conceptual bones of our framework, moving from the architectural vision in `9-webgl2-unit.md` into a concrete plan of action. It describes the new roles the `serve.js` orchestrator will adopt and the nature of the dynamic entities it will bring to life in the browser.

## Section 1: The Twin Gateways

Our server, `serve.js`, will evolve to guard two new, special-purpose gateways. These are not paths to static files, but portals that generate living code and content on demand.

*   **`GET /test` — The Supervisor's Berth:** A request to this URL is a summons for the test system's supervisor. The server will intercept this call and, rather than fetching a file from disk, will dynamically construct and serve a complete HTML page. This page is the Supervisor's vessel, a purpose-built environment containing a simple user interface for observing test progress and the foundational scripts for managing the entire test run.

*   **`GET /worker.js` — The Worker's Genesis Script:** This path serves the very soul of our Execution Cells. It delivers a JavaScript payload that will be executed within every Web Worker. This is the "doorman" script, containing the test harness, the communication logic for talking to the Supervisor, and the instructions for running an individual test.

## Section 2: Anatomy of the Supervisor (The `/test` Page)

The page served from `/test` is a sophisticated marionette, its strings pulled by the server.

*   **The Skeleton:** Its HTML body will be spartan, containing little more than a vessel for displaying results—perhaps a simple `<pre>` tag that will serve as a live log. Crucially, it will contain a `<script type="importmap">` block, the Rosetta Stone that allows the browser to understand bare module specifiers like `'three'`.

*   **The Injected Intellect:** The true "smarts" of the Supervisor are injected by `serve.js` at the moment of its creation. This primary script, running on the main browser thread, has a clear mandate:
    1.  **Report for Duty:** It first establishes a connection back to the `serve.js` REPL, announcing itself as the unique `test-runner`.
    2.  **Await Orders:** It then enters a listening state, awaiting a command from the Orchestrator that contains the full manifest of test files to be executed.
    3.  **Delegate and Dispatch:** Upon receiving the test manifest, it begins its core loop. For each test file in the list, it instantiates a new `Worker` from the `/worker.js` genesis script, ensuring it does so as a `type: 'module'` to grant it the power of the import map.
    4.  **Provide the Tools:** Before setting the worker loose, the Supervisor creates an `OffscreenCanvas` and transfers it, along with the specific path of the test file the worker is to run, via a `postMessage` call.
    5.  **Maintain Vigilance:** For every worker dispatched, a timer is started. If the timer expires before the worker reports back, the Supervisor terminates the worker and marks the test as "timed out."
    6.  **Tally the Results:** It listens for result messages from its worker fleet, updating the simple UI in real-time to paint a picture of the ongoing test run. When all workers have completed or timed out, it sends a final, aggregated report back to the Orchestrator in the Node.js console.

## Section 3: The Soul of the Worker (The `/worker.js` Script)

The script served from `/worker.js` is the blueprint for every Execution Cell. It is self-contained and knows its purpose from the moment it springs to life.

*   **The Handshake:** Its first action is to establish communication with its creator, the Supervisor, and await its one and only task. It anticipates a message containing the `OffscreenCanvas` and the path to a single test script.

*   **The Test Harness:** Before executing any test code, the worker populates its own global scope with a testing harness. This is a small, self-contained library that provides the essential testing vocabulary:
    *   An `it()` or `test()` function that accepts a description and an asynchronous test function.
    *   A suite of `assert` functions (`assert.ok`, `assert.equal`, etc.) for validating invariants.

*   **The Invitation:** With the harness in place, the worker uses a dynamic `import()` to load the test script it was assigned. Because it is a module worker, it can resolve any dependencies, like `three.js`, via the inherited import map.

*   **The Moment of Truth:** The `test()` function from the harness wraps the execution of the imported test code in a `try...catch` block. It diligently records success, failure, or any uncaught exception.

*   **The Final Word:** Upon completion, the worker sends a single, final message back to the Supervisor, containing the outcome of its test. Its purpose fulfilled, it then awaits termination.
