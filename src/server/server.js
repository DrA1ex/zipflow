import http from 'node:http';
import { once } from 'node:events';
import { ZIPFLOW_VERSION } from '../version.js';
import { API_VERSION } from '../protocol/index.js';
import { BlobStore } from './blob-store.js';
import { EventJournal } from './event-journal.js';
import { IdempotencyStore } from './idempotency-store.js';
import {
  reconcileInfrastructureReceipt,
  registerInfrastructureRoutes,
} from './infrastructure-routes.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { ServerLifecycle } from './lifecycle.js';
import { OperationRegistry } from './operation-registry.js';
import { createServerProblem } from './problems.js';
import { ProjectRegistry } from './project-registry.js';
import { probeExistingServer } from './probe.js';
import { LocalHttpRouter } from './router.js';
import {
  createRuntimeSecurity,
  ensureServerStorageDirectories,
  resolveServerPaths,
} from './runtime-paths.js';
import { SseHub } from './sse.js';
import { RunSessionStore } from './run-session-store.js';
import { WorkflowApplicationService } from '../application/workflow-application-service.js';
import { WorkflowResourceStore } from '../application/workflow-resource-store.js';
import { loadSettings } from '../settings/store.js';

export class ZipflowServer {
  constructor({
    paths = resolveServerPaths(),
    security = createRuntimeSecurity(paths),
    lifecycle = null,
    idleTimeoutMs = 0,
    blobMaxBytes = undefined,
    eventMaxRecords = undefined,
    heartbeatMs = undefined,
    token = undefined,
    inspectProject = undefined,
    loadRuntimeSettings = loadSettings,
    requestAutonomyDecision = null,
    workflowSummary = undefined,
    onError = () => {},
    createHttpServer = (handler) => http.createServer(handler),
  } = {}) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new TypeError('idleTimeoutMs must be a non-negative safe integer.');
    }
    this.paths = paths;
    this.security = security;
    this.lifecycle = lifecycle ?? new ServerLifecycle({
      paths,
      security,
      apiVersion: API_VERSION,
      zipflowVersion: ZIPFLOW_VERSION,
      probeExisting: probeExistingServer,
    });
    this.idleTimeoutMs = idleTimeoutMs;
    this.blobMaxBytes = blobMaxBytes;
    this.eventMaxRecords = eventMaxRecords;
    this.heartbeatMs = heartbeatMs;
    this.requestedToken = token;
    this.inspectProject = inspectProject;
    this.loadRuntimeSettings = loadRuntimeSettings;
    this.requestAutonomyDecision = requestAutonomyDecision;
    this.workflowSummary = workflowSummary;
    this.onError = onError;
    this.createHttpServer = createHttpServer;
    this.state = 'new';
    this.reused = false;
    this.discovery = null;
    this.token = null;
    this.httpServer = null;
    this.router = null;
    this.sse = null;
    this.activeRequests = 0;
    this.idleTimer = null;
  }

  async start() {
    if (this.state !== 'new') throw new Error(`Server cannot start from state ${this.state}.`);
    this.state = 'starting';
    const ownership = await this.lifecycle.prepare();
    if (ownership.reused) {
      this.reused = true;
      this.discovery = ownership.discovery;
      this.state = 'reused';
      return this;
    }

    try {
      await ensureServerStorageDirectories(this.paths, this.security);
      this.createServices();
      await this.initializeServices();
      const published = await this.lifecycle.publish(
        this.requestedToken ? { token: this.requestedToken } : {},
      );
      this.discovery = published.discovery;
      this.token = published.token;
      this.createRouter();
      this.httpServer = this.createHttpServer((request, response) => this.handleRequest(request, response));
      await listen(this.httpServer, this.paths.endpoint.listenPath);
      await this.lifecycle.markListening();
      this.state = 'running';
      this.scheduleIdleShutdown();
      return this;
    } catch (error) {
      await this.cleanupFailedStart();
      throw error;
    }
  }

  createServices() {
    this.projects = new ProjectRegistry({ root: this.paths.projectsRoot });
    this.blobs = new BlobStore({
      root: this.paths.blobsRoot,
      ...(this.blobMaxBytes === undefined ? {} : { maxBytes: this.blobMaxBytes }),
    });
    this.journal = new EventJournal({
      root: this.paths.eventsRoot,
      serverEpoch: this.lifecycle.serverEpoch,
      ...(this.eventMaxRecords === undefined ? {} : { maxEvents: this.eventMaxRecords }),
    });
    this.operations = new OperationRegistry({
      root: this.paths.operationsRoot,
      journal: this.journal,
    });
    this.idempotency = new IdempotencyStore({ root: this.paths.idempotencyRoot });
    this.workflows = new WorkflowResourceStore({ root: this.paths.workflowRevisionsRoot });
    this.sessions = new RunSessionStore({ runsRoot: this.paths.runsRoot });
    this.application = new WorkflowApplicationService({
      projects: this.projects,
      workflows: this.workflows,
      blobs: this.blobs,
      sessions: this.sessions,
      operations: this.operations,
      idempotency: this.idempotency,
      journal: this.journal,
      inspectProject: this.inspectProject,
      loadRuntimeSettings: this.loadRuntimeSettings,
      requestAutonomyDecision: this.requestAutonomyDecision,
      onError: this.onError,
    });
  }

  async initializeServices() {
    await this.projects.initialize();
    await this.blobs.initialize();
    await this.journal.initialize();
    await this.workflows.initialize();
    await this.sessions.initialize();
    await this.operations.initialize({
      reconcile: (operation) => this.application.reconcileOperation(operation),
    });
    await this.idempotency.initialize();
    const services = this.services();
    await this.idempotency.reconcileActive(async (record) => (
      await this.application.reconcileReceipt(record)
      ?? reconcileInfrastructureReceipt(record, services)
    ));
  }

  createRouter() {
    this.router = new LocalHttpRouter({
      token: this.token,
      problemFactory: createServerProblem,
      onError: this.onError,
    });
    this.sse = new SseHub({
      journal: this.journal,
      ...(this.heartbeatMs === undefined ? {} : { heartbeatMs: this.heartbeatMs }),
    });
    registerInfrastructureRoutes(this.router, {
      ...this.services(),
      sse: this.sse,
      inspectProject: this.inspectProject,
      workflowSummary: this.workflowSummary,
      acceptingMutations: () => this.state === 'running' || this.state === 'starting',
    });
    registerWorkflowRoutes(this.router, {
      application: this.application,
      acceptingMutations: () => this.state === 'running' || this.state === 'starting',
    });
  }

  services() {
    return {
      lifecycle: this.lifecycle,
      projects: this.projects,
      blobs: this.blobs,
      idempotency: this.idempotency,
      operations: this.operations,
      journal: this.journal,
      workflows: this.workflows,
      sessions: this.sessions,
      application: this.application,
      workflowSummary: this.workflowSummary,
    };
  }

  handleRequest(request, response) {
    this.activeRequests += 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.activeRequests -= 1;
      this.scheduleIdleShutdown();
    };
    response.once('finish', finish);
    response.once('close', finish);
    void this.router.handle(request, response).catch((error) => {
      this.onError(error);
      response.destroy();
    });
  }

  async close() {
    if (['closed', 'new', 'reused'].includes(this.state)) {
      this.state = 'closed';
      return;
    }
    if (this.state === 'stopping') return;
    const active = await this.operations.list({ activeOnly: true });
    if (active.length) {
      throw Object.assign(new Error('Server shutdown was refused while operations remain active.'), {
        code: 'SERVER_OPERATIONS_ACTIVE',
        operations: active.map((operation) => operation.operationId),
      });
    }
    this.state = 'stopping';
    clearTimeout(this.idleTimer);
    await this.journal.flushCoalesced();
    await this.journal.append('server.stopping', { data: {} });
    this.sse?.closeAll();
    if (this.httpServer?.listening) {
      const closed = once(this.httpServer, 'close');
      this.httpServer.close();
      await closed;
    }
    await this.lifecycle.close();
    this.state = 'closed';
  }

  scheduleIdleShutdown() {
    clearTimeout(this.idleTimer);
    if (!this.idleTimeoutMs || this.state !== 'running') return;
    this.idleTimer = setTimeout(() => {
      void this.closeIfIdle().catch(this.onError);
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async closeIfIdle() {
    if (this.state !== 'running' || this.activeRequests > 0 || this.sse?.connections.size) {
      this.scheduleIdleShutdown();
      return false;
    }
    if ((await this.operations.list({ activeOnly: true })).length) {
      this.scheduleIdleShutdown();
      return false;
    }
    await this.close();
    return true;
  }

  async cleanupFailedStart() {
    this.sse?.closeAll();
    if (this.httpServer?.listening) {
      const closed = once(this.httpServer, 'close');
      this.httpServer.close();
      await closed.catch(() => {});
    }
    await this.lifecycle.close().catch(() => {});
    this.state = 'closed';
  }
}

export async function startZipflowServer(options = {}) {
  return new ZipflowServer(options).start();
}

function listen(server, target) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(target);
  });
}
