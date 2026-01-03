/**
 * TickBorne Research — Data Pipeline
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  email: 'justin.strubel@gmail.com',
  searches: [
    { pathogen: 'lyme', query: 'lyme disease[Title/Abstract]', color: '#059669' },
    { pathogen: 'bartonella', query: 'bartonella[Title/Abstract]', color: '#db2777' },
    { pathogen: 'babesia', query: 'babesia[Title/Abstract] OR babesiosis[Title/Abstract]', color: '#2563eb' },
  ],
  papersPerPathogen: 10,
  daysBack: 90,
  claudeModel: 'claude-sonnet-4-20250514',
  outputDir: path.join(__dirname, '..', 'data'),
  outputFile: 'papers.json',
};

async function searchPubMed(query, maxResults = 10) {
  const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - CONFIG.daysBack);
  const formatDate = (d) => d.toISOString().split('T')[0].replace(/-/g, '/');
  
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: maxResults.toString(),
    retmode: 'json',
    sort: 'date',
    datetype: 'pdat',
    mindate: formatDate(startDate),
    maxdate: formatDate(endDate),
    email: CONFIG.email,
  });
  
  const response = await fetch(`${baseUrl}?${params}`);
  const data = await response.json();
  return data.esearchresult?.idlist || [];
}

async function fetchPaperDetails(pmids) {
  if (pmids.length === 0) return [];
  const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
    email: CONFIG.email,
  });
  
  const response = await fetch(`${baseUrl}?${params}`);
  const xml = await response.text();
  return parsePubMedXML(xml);
}

function parsePubMedXML(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const article = match[1];
    
    const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : null;
    
    const titleMatch = article.match(/<ArticleTitle>([^<]+)<\/ArticleTitle>/);
    const title = titleMatch ? decodeHTMLEntities(titleMatch[1]) : 'Untitled';
    
    const abstractMatch = article.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    let abstract = '';
    if (abstractMatch) {
      abstract = abstractMatch.map(a => decodeHTMLEntities(a.replace(/<[^>]+>/g, ''))).join(' ');
    }
    
    const authors = [];
    const authorRegex = /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<Initials>([^<]*)<\/Initials>[\s\S]*?<\/Author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(article)) !== null) {
      authors.push(`${authorMatch[1]} ${authorMatch[2]}`);
      if (authors.length >= 3) break;
    }
    
    const journalMatch = article.match(/<Title>([^<]+)<\/Title>/);
    const journal = journalMatch ? decodeHTMLEntities(journalMatch[1]) : 'Unknown Journal';
    
    const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(\d+)<\/Year>/);
    const monthMatch = article.match(/<PubDate>[\s\S]*?<Month>([^<]+)<\/Month>/);
    const dayMatch = article.match(/<PubDate>[\s\S]*?<Day>(\d+)<\/Day>/);
    
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear();
    const month = monthMatch ? monthMatch[1] : 'Jan';
    const day = dayMatch ? dayMatch[1] : '1';
    
    const typeMatch = article.match(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/);
    const articleType = typeMatch ? typeMatch[1] : 'Research Article';
    
    if (pmid && title) {
      papers.push({
        pmid,
        title,
        abstract,
        authors: authors.length > 0 ? authors : ['Unknown Author'],
        journal,
        publicationDate: `${month} ${day}, ${year}`,
        articleType,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    }
  }
  return papers;
}

function decodeHTMLEntities(text) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
}

async function generateSummary(paper) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey || !paper.abstract || paper.abstract.length < 100) {
    return {
      whatTheyFound: `This paper investigates aspects of tick-borne infections.`,
      whyItMatters: 'Read the full abstract for clinical details.',
      limitations: 'AI summary unavailable.',
      raw: '',
    };
  }
  
  const prompt = `You are a medical science translator helping patients understand research papers about tick-borne diseases.

Given this abstract, write a brief plain-English summary:

**What they found:** [1-2 sentences on main finding]
**Why it matters:** [1-2 sentences on practical significance]
**Limitations:** [1 sentence on key caveat]

Keep total under 100 words. Avoid jargon.

TITLE: ${paper.title}
ABSTRACT: ${paper.abstract}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.claudeModel,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    
    if (!response.ok) return { whatTheyFound: '', whyItMatters: '', limitations: '', raw: '' };
    
    const data = await response.json();
    const summary = data.content[0]?.text || '';
    
    const whatFound = summary.match(/\*\*What they found:\*\*\s*([^\*]+)/i);
    const whyMatters = summary.match(/\*\*Why it matters:\*\*\s*([^\*]+)/i);
    const limitations = summary.match(/\*\*Limitations:\*\*\s*([^\*]+)/i);
    
    return {
      whatTheyFound: whatFound ? whatFound[1].trim() : '',
      whyItMatters: whyMatters ? whyMatters[1].trim() : '',
      limitations: limitations ? limitations[1].trim() : '',
      raw: summary,
    };
  } catch (error) {
    return { whatTheyFound: '', whyItMatters: '', limitations: '', raw: '' };
  }
}

async function main() {
  console.log('🔬 TickBorne Research — Data Pipeline\n');
  
  const allPapers = [];
  
  for (const search of CONFIG.searches) {
    console.log(`📚 Fetching ${search.pathogen} papers...`);
    
    const pmids = await searchPubMed(search.query, CONFIG.papersPerPathogen);
    console.log(`   Found ${pmids.length} papers`);
    
    if (pmids.length === 0) continue;
    
    const papers = await fetchPaperDetails(pmids);
    console.log(`   Retrieved ${papers.length} paper details`);
    
    for (let i = 0; i < papers.length; i++) {
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 500));
      const summary = await generateSummary(papers[i]);
      allPapers.push({
        ...papers[i],
        pathogen: search.pathogen,
        pathogenColor: search.color,
        aiSummary: summary,
        fetchedAt: new Date().toISOString(),
      });
    }
    console.log(`   ✅ Completed ${search.pathogen}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  allPapers.sort((a, b) => new Date(b.publicationDate) - new Date(a.publicationDate));
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalPapers: allPapers.length,
    papers: allPapers,
  }, null, 2));
  
  console.log(`\n✅ Done! ${allPapers.length} papers saved to ${outputPath}`);
}

main().catch(console.error);
