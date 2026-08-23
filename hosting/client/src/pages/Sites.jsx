import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import {
  Upload,
  Globe,
  FilePlus,
  Trash2,
  HardDrive,
  Calendar,
  Copy,
  BookOpen,
  Package,
  Coins,
  CheckCircle,
  XCircle
} from 'lucide-react'

import './Sites.css'


function Sites({ token }) {

  const [sites, setSites] = useState([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [siteName, setSiteName] = useState('')
  const [domain, setDomain] = useState('')
  const [uploadingSite, setUploadingSite] = useState(null)
  const [loading, setLoading] = useState(true)


  useEffect(() => {
    fetchSites()
  }, [])


  const fetchSites = async () => {
    try {

      const response = await axios.get('/api/sites', {
        headers: {
          Authorization: `Bearer ${token}`
        }
      })

      setSites(response.data)

    } catch (error) {

      console.error('Erro ao carregar sites:', error)

    } finally {

      setLoading(false)

    }
  }



  const handleCreateSite = async (e) => {

    e.preventDefault()

    try {

      const response = await axios.post(
        '/api/sites',
        {
          name: siteName,
          domain: domain || null
        },
        {
          headers:{
            Authorization:`Bearer ${token}`
          }
        }
      )


      setSites([...sites,response.data])

      setSiteName('')
      setDomain('')
      setShowCreateForm(false)


    } catch(error){

      alert(
        'Erro ao criar site: ' +
        error.response?.data?.error
      )

    }

  }



  const handleFileUpload = async (e,siteId)=>{

    const file = e.target.files?.[0]

    if(!file) return


    setUploadingSite(siteId)


    const formData = new FormData()

    formData.append('file',file)


    try {


      const response = await axios.post(
        `/api/sites/${siteId}/upload`,
        formData,
        {
          headers:{
            Authorization:`Bearer ${token}`,
            'Content-Type':'multipart/form-data'
          }
        }
      )


      setSites(
        sites.map(s =>
          s.siteId === siteId
          ? response.data.site
          : s
        )
      )


      alert('Site deployado com sucesso!')


    }catch(error){


      alert(
        'Erro no upload: ' +
        error.response?.data?.error
      )


    }finally{

      setUploadingSite(null)

    }

  }



  if(loading)
    return <div className="loading">Carregando...</div>



  return (

<main>

<div className="container">


<div className="sites-header">

<div>

<h1>
<Globe size={32}/>
 Meus Sites
</h1>

<p>
Crie novos sites ou faça upload de projetos
</p>

</div>


<button
className="btn-primary"
onClick={()=>setShowCreateForm(!showCreateForm)}
>

<FilePlus size={18}/>

Novo Site

</button>


</div>



{showCreateForm && (

<div className="card create-form">


<h3>
<FilePlus size={22}/>
 Criar Novo Site
</h3>


<form onSubmit={handleCreateSite}>


<div className="form-group">

<label>
Nome do Site
</label>


<input
type="text"
value={siteName}
onChange={(e)=>setSiteName(e.target.value)}
placeholder="Meu Site Incrível"
required
/>

</div>



<div className="form-group">

<label>
Domínio (opcional)
</label>


<input
type="text"
value={domain}
onChange={(e)=>setDomain(e.target.value)}
placeholder="seudominio.com"
/>


</div>



<div className="form-actions">


<button
type="submit"
className="btn-primary"
>

<CheckCircle size={18}/>

Criar Site

</button>



<button
type="button"
className="btn-secondary"
onClick={()=>setShowCreateForm(false)}
>

<XCircle size={18}/>

Cancelar

</button>


</div>


</form>


</div>

)}




{sites.length === 0 ? (


<div className="empty-state">


<Globe size={48}/>


<h2>
Nenhum site criado ainda
</h2>


<p>
Clique em "Novo Site" para começar
</p>


</div>



):(



<div className="sites-grid">


{sites.map(site=>(


<div
key={site.siteId}
className="site-card"
>


<div className="site-header">


<h3>
{site.name}
</h3>


<span className="badge badge-success">

<CheckCircle size={14}/>

ATIVO

</span>


</div>



<div className="site-info">


<p className="site-domain">

<Globe size={15}/>

{site.domain}

</p>



<p className="site-storage">

<HardDrive size={15}/>

{(site.storageUsed / 1024 / 1024).toFixed(2)} MB

</p>



<p className="site-date">

<Calendar size={15}/>

{new Date(site.createdAt)
.toLocaleDateString('pt-BR')}

</p>


</div>



<div className="site-actions">


<label className="btn-upload">


<Upload size={18}/>


{
uploadingSite === site.siteId
? 'Upload...'
: 'Upload ZIP'
}



<input
type="file"
accept=".zip"
onChange={(e)=>handleFileUpload(e,site.siteId)}
disabled={uploadingSite===site.siteId}
style={{display:'none'}}
/>


</label>



<Link
to={`/sites/${site.siteId}`}
className="btn-secondary"
>

Gerenciar

</Link>


</div>




<div className="site-url">


<input
type="text"
value={site.url}
readOnly
className="url-input"
/>



<button
className="btn-copy"
onClick={()=>
navigator.clipboard.writeText(site.url)
}
>

<Copy size={18}/>

</button>


</div>


</div>


))}


</div>


)}





<div className="info-card">


<h3>

<BookOpen size={22}/>

Como funciona?

</h3>



<ol>


<li>
<FilePlus size={15}/>
 Crie um novo site nesta plataforma
</li>


<li>
<Package size={15}/>
 Faça um ZIP do projeto HTML/CSS/JS
</li>


<li>
<Upload size={15}/>
 Upload do ZIP será extraído automaticamente
</li>


<li>
<Globe size={15}/>
 Acesse via URL gerada em segundos
</li>


<li>
<Coins size={15}/>
 Pague apenas pelo que usar
</li>


</ol>


</div>


</div>

</main>

)

}


export default Sites