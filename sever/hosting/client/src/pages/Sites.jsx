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

import { useTranslation } from '../i18n/LanguageContext'
import './Sites.css'


function Sites({ token }) {
  const { t, lang } = useTranslation()

  const [sites, setSites] = useState([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [siteName, setSiteName] = useState('')
  const [domain, setDomain] = useState('')
  const [uploadingSite, setUploadingSite] = useState(null)
  const [loading, setLoading] = useState(true)
  const [deletingSite, setDeletingSite] = useState(null)


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
        t('sites.error.create') + ': ' +
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


      alert(t('sites.success.upload'))


    }catch(error){


      alert(
        t('sites.error.upload') + ': ' +
        error.response?.data?.error
      )


    }finally{

      setUploadingSite(null)

    }

  }



  const handleDeleteSite = async (site) => {
    const confirmed = window.confirm(t('sites.deleteConfirm', { name: site.name }))
    if (!confirmed) return

    setDeletingSite(site.siteId)

    try {
      await axios.delete(`/api/sites/${site.siteId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      setSites(sites.filter(s => s.siteId !== site.siteId))
    } catch (error) {
      alert(t('sites.error.delete') + ': ' + (error.response?.data?.error || error.message))
    } finally {
      setDeletingSite(null)
    }
  }

  if(loading)
    return <div className="loading">{t('common.loading')}</div>



  return (

<main>

<div className="container">


<div className="sites-header">

<div>

<h1>
<Globe size={32}/>
 {t('sites.title')}
</h1>

<p>
{t('sites.subtitle')}
</p>

</div>


<button
className="btn-primary"
onClick={()=>setShowCreateForm(!showCreateForm)}
>

<FilePlus size={18}/>

{t('sites.new')}

</button>


</div>



{showCreateForm && (

<div className="card create-form">


<h3>
<FilePlus size={22}/>
 {t('sites.create.title')}
</h3>


<form onSubmit={handleCreateSite}>


<div className="form-group">

<label>
{t('sites.create.name')}
</label>


<input
type="text"
value={siteName}
onChange={(e)=>setSiteName(e.target.value)}
placeholder={t('sites.create.namePlaceholder')}
required
/>

</div>



<div className="form-group">

<label>
{t('sites.create.domain')}
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

{t('sites.create.submit')}

</button>



<button
type="button"
className="btn-secondary"
onClick={()=>setShowCreateForm(false)}
>

<XCircle size={18}/>

{t('sites.create.cancel')}

</button>


</div>


</form>


</div>

)}




{sites.length === 0 ? (


<div className="empty-state">


<Globe size={48}/>


<h2>
{t('sites.empty.title')}
</h2>


<p>
{t('sites.empty.subtitle')}
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

{t('sites.active')}

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
.toLocaleDateString(lang === 'en' ? 'en-US' : 'pt-BR')}

</p>


</div>



<div className="site-actions">


<label className="btn-upload">


<Upload size={18}/>


{
uploadingSite === site.siteId
? t('sites.uploading')
: t('sites.upload')
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

{t('sites.manage')}

</Link>


<button
type="button"
className="btn-danger"
onClick={()=>handleDeleteSite(site)}
disabled={deletingSite===site.siteId}
title={t('sites.delete')}
>

<Trash2 size={18}/>

{
deletingSite === site.siteId
? t('sites.deleting')
: t('sites.delete')
}

</button>


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

{t('sites.how.title')}

</h3>



<ol>


<li>
<FilePlus size={15}/>
 {t('sites.how.step1')}
</li>


<li>
<Package size={15}/>
 {t('sites.how.step2')}
</li>


<li>
<Upload size={15}/>
 {t('sites.how.step3')}
</li>


<li>
<Globe size={15}/>
 {t('sites.how.step4')}
</li>


<li>
<Coins size={15}/>
 {t('sites.how.step5')}
</li>


</ol>


</div>


</div>

</main>

)

}


export default Sites