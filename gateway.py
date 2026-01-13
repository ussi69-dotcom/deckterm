import asyncio
import json
import logging
import uuid
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    NEEDS_INPUT = "needs_input"


class CreateJobRequest(BaseModel):
    task: str
    workflow: str
    model: Optional[str] = "anthropic/claude-opus-4"
    max_iterations: Optional[int] = 10
    ultrawork: Optional[bool] = False


class JobActionRequest(BaseModel):
    action: str


@dataclass
class Job:
    job_id: str
    task: str
    workflow: str
    model: str = "anthropic/claude-opus-4"
    ultrawork: bool = False
    status: JobStatus = JobStatus.PENDING
    progress: int = 0
    logs: List[str] = field(default_factory=list)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    retry_count: int = 0
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    process: Optional[asyncio.subprocess.Process] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "task": self.task,
            "workflow": self.workflow,
            "model": self.model,
            "ultrawork": self.ultrawork,
            "status": self.status.value,
            "progress": self.progress,
            "logs": self.logs,
            "result": self.result,
            "error": self.error,
            "retry_count": self.retry_count,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


jobs: Dict[str, Job] = {}
job_subscribers: Dict[str, List[asyncio.Queue]] = {}


async def execute_job(job: Job):
    opencode_bin = "/root/.opencode/bin/opencode"
    
    cmd = [
        opencode_bin, "run",
        "-m", job.model,
        "--agent", job.workflow,
        "--format", "json",
    ]
    
    if job.ultrawork:
        cmd.insert(4, "--variant")
        cmd.insert(5, "max")
    
    cmd.append(job.task)
    
    logger.info(f"[Job {job.job_id}] Executing: {' '.join(cmd)}")
    
    try:
        job.status = JobStatus.RUNNING
        job.started_at = datetime.now()
        await emit_sse_event(job.job_id, {"type": "status", "status": "running"})
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd="/workspace"
        )
        job.process = proc
        
        if proc.stdout:
            async for line in proc.stdout:
                line_str = ""
                try:
                    line_str = line.decode('utf-8').strip()
                    if not line_str:
                        continue
                        
                    event = json.loads(line_str)
                    await handle_opencode_event(job, event)
                    
                except json.JSONDecodeError:
                    if line_str:
                        logger.debug(f"[Job {job.job_id}] Non-JSON line: {line_str}")
                    continue
                except Exception as e:
                    logger.error(f"[Job {job.job_id}] Error processing event: {e}")
                    continue
        
        await proc.wait()
        
        if proc.returncode != 0 and job.status != JobStatus.COMPLETED:
            error_msg = f"Process exited with code {proc.returncode}"
            
            if proc.stderr:
                stderr_data = await proc.stderr.read()
                if stderr_data:
                    error_msg += f"\nStderr: {stderr_data.decode('utf-8')}"
            
            await handle_job_error(job, error_msg)
        
        if job.status == JobStatus.RUNNING:
            job.status = JobStatus.COMPLETED
            job.progress = 100
            job.finished_at = datetime.now()
            job.result = {"success": True, "logs": job.logs}
            await emit_sse_event(job.job_id, {
                "type": "status",
                "status": "completed",
                "result": job.result
            })
        
    except Exception as e:
        logger.error(f"[Job {job.job_id}] Execution error: {e}")
        await handle_job_error(job, str(e))
    finally:
        job.process = None


async def handle_opencode_event(job: Job, event: Dict[str, Any]):
    event_type = event.get("type")
    part = event.get("part", {})
    
    if event_type == "step_start":
        job.progress = max(job.progress, 10)
        await emit_sse_event(job.job_id, {"type": "progress", "value": job.progress})
        logger.info(f"[Job {job.job_id}] Step started")
        
    elif event_type == "text":
        text = part.get("text", "")
        if text:
            job.logs.append(text)
            job.progress = min(90, job.progress + 5)
            await emit_sse_event(job.job_id, {
                "type": "log",
                "message": text,
                "progress": job.progress
            })
            logger.debug(f"[Job {job.job_id}] Text: {text[:100]}...")
            
    elif event_type == "step_finish":
        reason = part.get("reason", "")
        
        if reason == "stop":
            job.status = JobStatus.COMPLETED
            job.progress = 100
            job.finished_at = datetime.now()
            job.result = {"success": True, "logs": job.logs}
            await emit_sse_event(job.job_id, {
                "type": "status",
                "status": "completed",
                "result": job.result
            })
            logger.info(f"[Job {job.job_id}] Completed successfully")
        else:
            error_msg = part.get("error", f"Failed with reason: {reason}")
            await handle_job_error(job, error_msg)


async def handle_job_error(job: Job, error_msg: str):
    job.retry_count += 1
    logger.warning(f"[Job {job.job_id}] Error (attempt {job.retry_count}/3): {error_msg}")
    
    if job.retry_count >= 3:
        job.status = JobStatus.NEEDS_INPUT
        job.error = error_msg
        job.finished_at = datetime.now()
        await emit_sse_event(job.job_id, {
            "type": "status",
            "status": "needs_input",
            "error": error_msg,
            "retry_count": job.retry_count
        })
        logger.error(f"[Job {job.job_id}] Max retries reached, needs user input")
    else:
        logger.info(f"[Job {job.job_id}] Auto-retrying...")
        await asyncio.sleep(2)
        await execute_job(job)


async def emit_sse_event(job_id: str, data: Dict[str, Any]):
    if job_id in job_subscribers:
        for queue in job_subscribers[job_id]:
            try:
                await queue.put(data)
            except Exception as e:
                logger.error(f"Error emitting SSE event: {e}")


async def subscribe_to_job(job_id: str) -> asyncio.Queue:
    queue = asyncio.Queue()
    if job_id not in job_subscribers:
        job_subscribers[job_id] = []
    job_subscribers[job_id].append(queue)
    return queue


async def unsubscribe_from_job(job_id: str, queue: asyncio.Queue):
    if job_id in job_subscribers:
        try:
            job_subscribers[job_id].remove(queue)
            if not job_subscribers[job_id]:
                del job_subscribers[job_id]
        except ValueError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Gateway starting up...")
    yield
    logger.info("Gateway shutting down...")
    for job in jobs.values():
        if job.process:
            job.process.kill()


app = FastAPI(
    title="OpenCode Gateway",
    description="OpenAI-compatible API for OpenCode workflows",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/v1/health")
async def health():
    return {
        "status": "healthy",
        "jobs": {
            "total": len(jobs),
            "pending": len([j for j in jobs.values() if j.status == JobStatus.PENDING]),
            "running": len([j for j in jobs.values() if j.status == JobStatus.RUNNING]),
            "completed": len([j for j in jobs.values() if j.status == JobStatus.COMPLETED]),
            "failed": len([j for j in jobs.values() if j.status == JobStatus.FAILED]),
            "needs_input": len([j for j in jobs.values() if j.status == JobStatus.NEEDS_INPUT]),
        }
    }


@app.post("/v1/jobs")
async def create_job(request: CreateJobRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    
    job = Job(
        job_id=job_id,
        task=request.task,
        workflow=request.workflow,
        model=request.model or "anthropic/claude-opus-4",
        ultrawork=request.ultrawork or False
    )
    
    jobs[job_id] = job
    logger.info(f"Created job {job_id}: {request.task[:50]}...")
    
    background_tasks.add_task(execute_job, job)
    
    return {
        "job_id": job_id,
        "status": job.status.value,
        "created_at": job.created_at.isoformat()
    }


@app.get("/v1/jobs")
async def list_jobs():
    return {
        "jobs": [job.to_dict() for job in jobs.values()],
        "total": len(jobs)
    }


@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return job.to_dict()


@app.delete("/v1/jobs/{job_id}")
async def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.status not in [JobStatus.PENDING, JobStatus.RUNNING]:
        raise HTTPException(status_code=400, detail="Job is not running")
    
    if job.process:
        job.process.kill()
        await job.process.wait()
    
    job.status = JobStatus.FAILED
    job.finished_at = datetime.now()
    job.error = "Cancelled by user"
    
    await emit_sse_event(job_id, {
        "type": "status",
        "status": "failed",
        "error": "Cancelled by user"
    })
    
    return {"job_id": job_id, "status": "cancelled"}


@app.get("/v1/jobs/{job_id}/stream")
async def stream_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    async def event_generator():
        queue = await subscribe_to_job(job_id)
        
        try:
            yield f"data: {json.dumps({'type': 'status', 'status': job.status.value, 'progress': job.progress})}\n\n"
            
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps(event)}\n\n"
                    
                    if event.get("type") == "status" and event.get("status") in ["completed", "failed", "needs_input"]:
                        yield f"data: {json.dumps({'type': 'complete'})}\n\n"
                        break
                        
                except asyncio.TimeoutError:
                    yield f": heartbeat\n\n"
                    continue
                    
        except asyncio.CancelledError:
            logger.info(f"Client disconnected from job {job_id} stream")
        finally:
            await unsubscribe_from_job(job_id, queue)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.post("/v1/jobs/{job_id}/action")
async def job_action(job_id: str, request: JobActionRequest, background_tasks: BackgroundTasks):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job.status != JobStatus.NEEDS_INPUT:
        raise HTTPException(status_code=400, detail="Job is not in needs_input state")
    
    if request.action == "retry":
        job.status = JobStatus.RUNNING
        job.retry_count = 0
        job.error = None
        logger.info(f"[Job {job_id}] User requested retry")
        background_tasks.add_task(execute_job, job)
        
    elif request.action == "skip":
        job.status = JobStatus.FAILED
        job.finished_at = datetime.now()
        job.result = {"error": "Skipped by user"}
        await emit_sse_event(job_id, {
            "type": "status",
            "status": "failed",
            "result": job.result
        })
        logger.info(f"[Job {job_id}] User skipped error")
        
    elif request.action == "abort":
        job.status = JobStatus.FAILED
        job.finished_at = datetime.now()
        job.result = {"error": "Aborted by user"}
        await emit_sse_event(job_id, {
            "type": "status",
            "status": "failed",
            "result": job.result
        })
        logger.info(f"[Job {job_id}] User aborted job")
        
    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {request.action}")
    
    return {"job_id": job_id, "status": job.status.value}


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "gateway:app",
        host="0.0.0.0",
        port=8765,
        reload=True,
        log_level="info"
    )
