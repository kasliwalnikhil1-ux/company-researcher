'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Tree from 'react-d3-tree';
import { motion } from 'framer-motion';

interface MindMapNode {
  title: string;
  description?: string;
  children?: MindMapNode[];
}

interface CompanyMapData {
  companyName: string;
  rootNode: {
    title: string;
    children: MindMapNode[];
  };
}

interface CompanyMindMapProps {
  data: CompanyMapData | null;
}

interface TreeNode {
  name: string;
  description?: string;
  children: TreeNode[];
}

const CustomNode = ({ nodeDatum, isMobile }: any) => (
  <foreignObject 
    width={isMobile ? 160 : 280} 
    height={80} 
    x={isMobile ? -80 : -140} 
    y={-40}
  >
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="bg-[var(--secondary-faint)] p-2 md:p-4 rounded-xl border border-[var(--secondary-darkest)] 
                 hover:shadow-md hover:border-[var(--secondary-accent)] transition-all duration-300 
                 backdrop-blur-sm"
    >
      <div className="font-semibold text-[11px] md:text-sm text-gray-800 mb-1 md:mb-1.5 line-clamp-1">
        {nodeDatum.name}
      </div>
      {nodeDatum.description && (
        <div className="text-[9px] md:text-xs text-gray-600 line-clamp-2 leading-relaxed">
          {nodeDatum.description}
        </div>
      )}
    </motion.div>
  </foreignObject>
);

const CompanyMindMap: React.FC<CompanyMindMapProps> = ({ data }) => {
  if (!data || !data.rootNode || !Array.isArray(data.rootNode.children)) {
    return (
      <div className="w-full h-[400px] bg-[var(--white)] rounded-md shadow-inner relative 
                  border border-[var(--secondary-darker)] flex items-center justify-center">
        <div className="text-center p-4">
          <h3 className="text-lg font-medium text-gray-800 mb-2">Mind Map</h3>
          <div className="text-gray-500">No mindmap data available for this company</div>
        </div>
      </div>
    );
  }
  
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    // Initial check
    checkMobile();
    
    // Add event listener
    window.addEventListener('resize', checkMobile);
    
    // Cleanup
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const transformData = (node: MindMapNode): TreeNode => {
    return {
      name: node.title || 'Untitled',
      description: node.description || '',
      children: (node.children || []).map(transformData),
    };
  };

  const treeData: TreeNode = {
    name: data.companyName || 'Company',
    description: data.rootNode?.title || '',
    children: (data.rootNode?.children || []).map(transformData),
  };

  const handleNodeClick = useCallback((nodeData: any) => {
    // Add click animation or interaction logic here if needed
  }, []);

  const renderCustomNodeElement = (nodeData: any) => (
    <CustomNode {...nodeData} isMobile={isMobile} />
  );

  return (
    <div className="w-full h-[500px] bg-[var(--white)] rounded-md shadow-inner relative 
                    border border-[var(--secondary-darker)]">
      <div className="absolute top-4 left-4 z-10 bg-white/80 px-3 py-1 rounded-md shadow-sm">
        <h3 className="text-lg font-medium text-gray-800">Company Mind Map</h3>
      </div>
      <Tree
        data={treeData}
        orientation="horizontal"
        nodeSize={{ 
          x: isMobile ? 250 : 600, 
          y: isMobile ? 30 : 60 
        }}
        separation={{ 
          siblings: isMobile ? 1 : 1.7, 
          nonSiblings: isMobile ? 1.2 : 2.2 
        }}
        translate={{ 
          x: isMobile ? 80 : 150, 
          y: isMobile ? 180 : 350 
        }}
        renderCustomNodeElement={renderCustomNodeElement}
        pathClassFunc={() => 'stroke-[var(--secondary-accent)] stroke-[1.5px] transition-all duration-300'}
        zoom={isMobile ? 0.6 : 0.5}
        onNodeClick={handleNodeClick}
        enableLegacyTransitions={true}
        transitionDuration={800}
      />
    </div>
  );
};

export default CompanyMindMap;