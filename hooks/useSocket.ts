'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'

interface UseSocketOptions {
  projectId?: string
  sessionToken?: string
}

/**
 * Connect to the terminal's built-in socket.io server.
 * No auth needed — it's the same process.
 */
export function useSocket({ projectId, sessionToken }: UseSocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [agentOnline, setAgentOnline] = useState(true) // always "online" since we ARE the agent

  useEffect(() => {
    const socket = io('/', {
      path: '/api/socket',
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setAgentOnline(true)
    })

    socket.on('disconnect', () => {
      setConnected(false)
      setAgentOnline(false)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  const emit = useCallback((event: string, data?: unknown) => {
    socketRef.current?.emit(event, data)
  }, [])

  return { socket: socketRef.current, connected, agentOnline, emit }
}
