// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next'
import { prisma } from '../../../lib/prisma'
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@prisma/client/runtime/library';

export default async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== 'GET') {
        return res.status(405).json({ message: 'Invalid API Method'})
    }

    // Function to parse through the URI and check if it's valid and return the data
    async function buildCache(instanceURI: string, instanceType: string) {
        if (instanceType == 'mastodon') {
            let init = { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }
            let verifyURI = 'https://' + instanceURI + '/api/v1/instance'
            try {
                const fetchingData = await fetch(verifyURI, init)
                const mastodonData = await fetchingData.json()
                const parsedMasterData = {
                    title: mastodonData.title,
                    description: mastodonData.short_description !== undefined ? mastodonData.short_description : mastodonData.description, // Pleroma instances don't have a short_description field, so we use the description field instead
                    thumbnail: mastodonData.thumbnail,
                    user_count: mastodonData.stats.user_count,
                    status_count: mastodonData.stats.status_count,
                    instance_contact: mastodonData.contact_account.username,
                    registrations: mastodonData.registrations,
                    approval_required: mastodonData.approval_required,
                }
                return parsedMasterData
            } catch (err) {
                return false
            }
        } else if (instanceType == 'misskey') {
            let getDetails = { detail: true }
            let init = { 
                headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                body: JSON.stringify(getDetails),
                method: 'POST'
            }
            let metaURI = 'https://' + instanceURI + '/api/meta'
            let statsURI = 'https://' + instanceURI + '/api/stats'
            try {
                const fetchingData = await fetch(metaURI, init)
                const fetchingData2 = await fetch(statsURI, init)
                const misskeyMetaData = await fetchingData.json()
                const misskeyStatsData = await fetchingData2.json()
                const parsedMasterData = {
                    title: misskeyMetaData.name,
                    description: misskeyMetaData.description,
                    thumbnail: misskeyMetaData.bannerUrl,
                    user_count: misskeyStatsData.originalUsersCount,
                    status_count: misskeyStatsData.notesCount,
                    instance_contact: 'null',
                    registrations: misskeyMetaData.disableRegistration === false,
                    approval_required: false,
                }
                return parsedMasterData
            } catch (err) {
                return false
            }
        } else {
            return false
        }
    }

    const allInstances = await prisma.instances.findMany({ where: { banned: true, ban_reason: 'Instance failed 5 checks in a row' } })
    for (let i = 0; i < allInstances.length; i++) {
        try {
            let updateInstance = await buildCache(allInstances[i].uri, allInstances[i].api_mode)
            if (updateInstance != false) {
                await prisma.instanceData.update({
                    where: { instance_id: allInstances[i].id },
                    data: {
                        title: updateInstance.title,
                        description: updateInstance.description,
                        thumbnail: updateInstance.thumbnail,
                        user_count: updateInstance.user_count,
                        status_count: updateInstance.status_count,
                        registrations: updateInstance.registrations,
                        approval_required: updateInstance.approval_required,
                    },
                })
                await prisma.instances.update({
                    where: { id: allInstances[i].id },
                    data: {
                        failed_checks: 0,
                        banned: false,
                        ban_reason: ''
                    },
                })
            }else{
                if (allInstances[i].failed_checks >= 5) {
                    await prisma.instances.update({
                        where: { id: allInstances[i].id },
                        data: {
                            banned: true,
                            ban_reason: 'Instance failed 5 checks in a row',
                        },
                    })
                } else {
                    await prisma.instances.update({
                        where: { id: allInstances[i].id },
                        data: {
                            failed_checks: allInstances[i].failed_checks + 1,
                        },
                    })
                }
            }
        } catch (err) {
            if (err instanceof PrismaClientKnownRequestError){
                res.status(400).json({"message": err.message })
            } else if (err instanceof PrismaClientValidationError){
                res.status(400).json({"message": err.message })
            }
        }
    }
    res.status(200).json({"message": "successfully updated instances"})
}
