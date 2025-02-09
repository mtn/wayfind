import type React from "react"
import type { ReactNode } from "react"

interface TreeNodeProps {
  children: ReactNode
  onClick?: () => void
  selected?: boolean
}

export const TreeNode: React.FC<TreeNodeProps> = ({ children, onClick, selected }) => {
  return (
    <li onClick={onClick} className={`cursor-pointer p-2 hover:bg-gray-100 ${selected ? "bg-blue-100" : ""}`}>
      {children}
    </li>
  )
}

interface TreeProps {
  children: ReactNode
}

export const Tree: React.FC<TreeProps> = ({ children }) => {
  return <ul className="space-y-1">{children}</ul>
}

