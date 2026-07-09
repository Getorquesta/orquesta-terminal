'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'

interface UseSocketOptions {
  projectId: string
  sessionToken: string
}

export function useSocket({ projectId, sessionToken }: UseSocketOptions) {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  // Track connected agent count so multi-agent scenarios work correctly
  const agentCountRef = useRef(0)
  const [agentOnline, setAgentOnline] = useState(false)

  useEffect(() => {
    if (!projectId || !sessionToken) return

    const socket = io('/', {
      path: '/api/socket',
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      // Join the project room — server validates session and replies with agent:status
      socket.emit('join:project', { projectId, sessionToken })
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setAgentOnline(false)
      agentCountRef.current = 0
    })

    // Server sends this immediately after join:project with current agent count
    socket.on('agent:status', (data: { connectedAgents: number }) => {
      agentCountRef.current = data.connectedAgents
      setAgentOnline(data.connectedAgents > 0)
    })

    socket.on('agent:online', () => {
      agentCountRef.current += 1
      setAgentOnline(true)
    })

    socket.on('agent:offline', () => {
      agentCountRef.current = Math.max(0, agentCountRef.current - 1)
      setAgentOnline(agentCountRef.current > 0)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
      agentCountRef.current = 0
    }
  }, [projectId, sessionToken])

  const emit = useCallback((event: string, data?: unknown) => {
    socketRef.current?.emit(event, data)
  }, [])

  return { socket: socketRef.current, connected, agentOnline, emit }
}
